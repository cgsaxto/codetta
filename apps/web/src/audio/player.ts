import * as Tone from 'tone';
import {
  BEATS_PER_BAR,
  TICKS_PER_BAR,
  TICKS_PER_BEAT,
  scoreDurationSeconds,
  type NoteEvent,
  type Score,
} from '../music/score';
import { clipWindow } from '../music/clip';
import { masterBus } from './engine';
import { KITS, type Waveform } from './kits';
import { encodeWav, sliceWithFades } from './wav';

/**
 * Tone types a synth's oscillator options as a discriminated union covering FM, AM and Fat
 * oscillators, each with its own companion fields. There is no member of that union meaning
 * "one of the plain waveform names", so a value typed as such cannot be narrowed into it.
 *
 * One cast, in one place, over a closed union of six strings that Tone accepts at runtime —
 * rather than the alternative of enumerating every branch at all six call sites.
 */
type OscillatorOptions = NonNullable<
  NonNullable<ConstructorParameters<typeof Tone.Synth>[0]>['oscillator']
>;

function osc(type: Waveform): OscillatorOptions {
  return { type } as OscillatorOptions;
}

/**
 * Plays a Score. This layer knows nothing about repositories or music theory — it receives
 * note events and turns them into sound.
 *
 * Every event is scheduled on Tone.Transport in bars:beats:sixteenths, never in seconds and
 * never on a wall-clock timer. Positions stay exact at any tempo, and drift is impossible
 * rather than merely unlikely.
 */

function ticksToTransportTime(ticks: number): string {
  const bar = Math.floor(ticks / TICKS_PER_BAR);
  const remainder = ticks % TICKS_PER_BAR;
  const beat = Math.floor(remainder / TICKS_PER_BEAT);
  return `${bar}:${beat}:${remainder % TICKS_PER_BEAT}`;
}

interface ScheduledNote extends NoteEvent {
  /** Tone.Part reads this to place the event on the transport. */
  time: string;
}

export interface Player {
  /** Idempotent: safe to call from a React cleanup that may run twice. */
  stop(): void;
  /**
   * Seconds into the piece, as it is being heard rather than as it has been scheduled.
   *
   * Not `Transport.seconds`, which is the obvious reading and is wrong by a fixed amount.
   * That getter resolves to `TickSource.getSecondsAtTime(this.now())`, and Tone's `now()` is
   * `context.currentTime + context.lookAhead` — the scheduler looks 100 ms ahead by default
   * so that it can place events before they are due. Anything drawn from it is a tenth of a
   * second early, which at 120 BPM is most of a sixteenth: not drift, a constant lead, on
   * every beat of every piece.
   *
   * Asking for the position at the context's actual current time removes it.
   */
  positionSeconds(): number;
  /**
   * The spectrum currently reaching the master limiter, normalised to 0–1.
   *
   * Read directly from the Web Audio graph on a render frame. The visual never estimates
   * loudness from scheduled notes, so an envelope, filter or reverb tail is visible for
   * exactly as long as it is audible.
   */
  spectrum(): Float32Array;
}

export interface PlaybackOptions {
  /** Repeat the piece. The roadmap gate is whether pad and bass are pleasant on loop. */
  loop?: boolean;
}

/** Everything one performance of a Score owns, live or offline. */
interface Rig {
  part: Tone.Part<ScheduledNote>;
  pad: Tone.PolySynth;
  dispose(): void;
}

/**
 * Build the instruments and place every note on the transport, in whatever context is
 * current.
 *
 * Extracted so that rendering a file and playing one out loud are the same code rather than
 * two implementations that agree until they do not. A separate offline graph would be a
 * second copy of every envelope, every cutoff and every gain that Phase 0 found by ear, and
 * the first divergence would show up as a downloaded file that sounds unlike the thing the
 * visitor pressed play on — which is the one property the share artifact cannot lose.
 *
 * It does not start anything. The caller owns the transport, because live playback loops and
 * a render must not.
 */
async function buildRig(score: Score): Promise<Rig> {
  const master = masterBus();

  // Envelope times are fractions of a bar, not fixed seconds. Tempo is repo-dependent, so
  // a fixed release that crossfades nicely at 116 BPM piles chords up at 72.
  const barSeconds = (60 / score.bpm) * BEATS_PER_BAR;

  // Which instruments play. Chosen from the seed in music/skeleton.ts and carried in the
  // Score, so a rendered piece names its own sound rather than depending on what this file
  // happened to hardcode. See audio/kits.ts for what a kit may and may not change.
  const kit = KITS[score.kit];

  const padGain = new Tone.Gain(Tone.dbToGain(-15)).connect(master);
  // The tail has to die inside the bar that produced it. Reverb longer than the chord cycle
  // is a dense copy of the previous harmony sounding underneath the current one, which is
  // the same pile-up as a long release but harder to hear as a cause.
  const padReverb = new Tone.Reverb({
    decay: barSeconds * 0.6,
    preDelay: 0.02,
    wet: 0.16,
  }).connect(padGain);
  const padFilter = new Tone.Filter({
    frequency: kit.pad.cutoff,
    type: 'lowpass',
    rolloff: -12,
  }).connect(padReverb);
  // Keeps the pad out of the bass fundamentals. The lowest pad note is C3 at 131 Hz, so
  // this removes rumble below the voice rather than thinning it.
  const padHighpass = new Tone.Filter({
    frequency: 110,
    type: 'highpass',
    rolloff: -12,
  }).connect(padFilter);
  const pad = new Tone.PolySynth(Tone.Synth, {
    oscillator: osc(kit.pad.oscillator),
    envelope: {
      attack: barSeconds * 0.1,
      decay: barSeconds * 0.25,
      sustain: 0.7,
      // Must stay well under one bar. Longer, and each chord is still sounding when the
      // next two arrive, which makes the Score's 8-note ceiling a fiction acoustically.
      release: barSeconds * kit.pad.release,
    },
  }).connect(padHighpass);

  const bassGain = new Tone.Gain(Tone.dbToGain(-10)).connect(master);
  /**
   * A filter envelope rather than a fixed lowpass, because the problem is not that the bass
   * is too bright — it is that its harmonics sustain.
   *
   * A triangle at G1 (49 Hz) puts its third harmonic at 147 Hz, right under the pad's lowest
   * note. No fixed cutoff removes that without taking the fundamental with it. So the filter
   * opens for the attack, where the harmonics read as definition and make the note audible on
   * anything that is not a pair of studio monitors, then shuts to near the fundamental for the
   * sustain, where they would only be mud.
   */
  const bass = new Tone.MonoSynth({
    oscillator: osc(kit.bass.oscillator),
    envelope: {
      attack: 0.008,
      decay: barSeconds * 0.18,
      sustain: 0.45,
      // Shorter than the 16th of silence the bass line leaves, so the gap stays a gap.
      release: barSeconds * 0.04,
    },
    filter: { type: 'lowpass', rolloff: -24, Q: 1 },
    filterEnvelope: {
      attack: 0.004,
      decay: barSeconds * 0.09,
      // Settles around 100 Hz: fundamentals pass, the third harmonic does not.
      sustain: 0.06,
      release: barSeconds * 0.04,
      baseFrequency: 90,
      octaves: kit.bass.octaves,
    },
  }).connect(bassGain);

  const leadGain = new Tone.Gain(Tone.dbToGain(-13)).connect(master);
  // Some of the pad's space so the lead does not sit in front of the track, but much less
  // of it — a wet lead loses the articulation that makes it read as a line.
  const leadReverb = new Tone.Reverb({
    decay: barSeconds * 0.5,
    preDelay: 0.01,
    wet: 0.14,
  }).connect(leadGain);
  const leadFilter = new Tone.Filter({
    frequency: kit.lead.cutoff,
    type: 'lowpass',
    rolloff: -12,
  }).connect(leadReverb);
  // Short and plucked. A sustaining lead would refill the midrange the pad was just cleared
  // out of, and the notes are as close as a 16th apart.
  const lead = new Tone.Synth({
    oscillator: osc(kit.lead.oscillator),
    envelope: {
      attack: 0.005,
      decay: barSeconds * kit.lead.decay,
      sustain: kit.lead.sustain,
      release: 0.18,
    },
  }).connect(leadFilter);

  // Well under the lead. The arp is motion, not a second melody, and the moment it is loud
  // enough to follow it starts competing with the tune for attention.
  const arpGain = new Tone.Gain(Tone.dbToGain(-21)).connect(master);
  const arpFilter = new Tone.Filter({
    frequency: kit.arp.cutoff,
    type: 'lowpass',
    rolloff: -12,
  }).connect(arpGain);
  // Notes butt up against each other, so the decay has to finish inside its own slot or the
  // figure smears into a chord.
  const arp = new Tone.Synth({
    oscillator: osc(kit.arp.oscillator),
    envelope: { attack: 0.004, decay: barSeconds * 0.06, sustain: 0.05, release: 0.08 },
  }).connect(arpFilter);

  const bellGain = new Tone.Gain(Tone.dbToGain(-24)).connect(master);
  /**
   * The tail has to be mostly gone by the time the chord changes.
   *
   * A bell is meant to hang in the air, but the harmony moves every bar, and a high sine
   * still ringing over the next chord is the most exposed dissonance available — it reads
   * as the bell being out of tune rather than as a suspension. music/ picks tones the
   * neighbouring chords share where it can; this is the other half of the same fix, and it
   * is what covers the progressions that have no shared tone to offer.
   */
  const bellReverb = new Tone.Reverb({
    decay: barSeconds * 0.7,
    preDelay: 0.01,
    wet: kit.bell.wet,
  }).connect(bellGain);
  const bell = new Tone.Synth({
    oscillator: osc(kit.bell.oscillator),
    envelope: {
      attack: 0.002,
      decay: barSeconds * kit.bell.decay,
      sustain: 0,
      release: barSeconds * 0.25,
    },
  }).connect(bellReverb);

  /**
   * The one place a repo feature reaches timbre. music/ hands over `openness` on 0–1 and
   * this owns what that means in hertz — commentRatio never picks a cutoff itself.
   */
  const openness = score.timbre.texture?.openness ?? 0;
  const textureGain = new Tone.Gain(Tone.dbToGain(-24)).connect(master);
  const textureReverb = new Tone.Reverb({
    decay: barSeconds * 1.2,
    preDelay: 0.03,
    wet: 0.3 + openness * 0.35,
  }).connect(textureGain);
  /**
   * The floor is where the whole range lives or dies, and 320 Hz was below it.
   *
   * This voice sits in C3–C4, so its fundamental is 130–262 Hz and a lowpass at 320 keeps
   * the first two harmonics of a triangle wave and throws away everything that makes it a
   * timbre rather than a sine. A module with few comments — psf/requests' test server, at
   * 0.06 — landed there and simply disappeared. 700 Hz keeps about five harmonics at the
   * bottom of the register, which is dark but present, and that is the intent: the texture
   * is felt rather than heard, and inaudible is not the same as felt.
   */
  const textureFilter = new Tone.Filter({
    frequency: 700 + openness * 2100,
    type: 'lowpass',
    rolloff: -24,
  }).connect(textureReverb);
  // Slower in and out than anything else. It is a bed, and the moment its attack is audible
  // as an event it has become a second bass.
  const texture = new Tone.Synth({
    oscillator: osc(kit.texture.oscillator),
    envelope: {
      attack: barSeconds * 0.4,
      decay: barSeconds * 0.3,
      sustain: 0.6,
      release: barSeconds * 0.6,
    },
  }).connect(textureFilter);

  // Impulse responses are generated asynchronously; starting first gives a dry opening bar.
  await Promise.all([padReverb.ready, leadReverb.ready, bellReverb.ready, textureReverb.ready]);

  const instruments = { pad, bass, lead, arp, bell, texture } as const;

  const part = new Tone.Part<ScheduledNote>(
    (time, note) => {
      const instrument =
        note.voice === 'bass'
          ? instruments.bass
          : note.voice === 'lead'
            ? instruments.lead
            : note.voice === 'arp'
              ? instruments.arp
              : note.voice === 'bell'
                ? instruments.bell
                : note.voice === 'texture'
                  ? instruments.texture
                  : instruments.pad;
      instrument.triggerAttackRelease(
        Tone.Frequency(note.midi, 'midi').toFrequency(),
        ticksToTransportTime(note.durationTicks),
        time,
        note.velocity,
      );
    },
    score.events.map((event) => ({ ...event, time: ticksToTransportTime(event.tick) })),
  );

  return {
    part,
    pad,
    dispose() {
      pad.releaseAll();
      part.dispose();
      for (const node of [
        pad,
        padHighpass,
        padFilter,
        padReverb,
        padGain,
        bass,
        bassGain,
        lead,
        leadFilter,
        leadReverb,
        leadGain,
        arp,
        arpFilter,
        arpGain,
        bell,
        bellReverb,
        bellGain,
        texture,
        textureFilter,
        textureReverb,
        textureGain,
      ]) {
        node.dispose();
      }
    },
  };
}

export async function startPlayback(
  score: Score,
  options: PlaybackOptions = {},
): Promise<Player> {
  const { loop = true } = options;

  await Tone.start();
  const rig = await buildRig(score);
  const analyser = new Tone.FFT({ size: 128, smoothing: 0.82, normalRange: true });
  // Keep the exact live bus. Tone.Offline temporarily swaps the global context, so looking
  // the bus up again during stop could otherwise try to disconnect this analyser from an
  // offline limiter it was never connected to and throw InvalidAccessError.
  const liveMaster = masterBus();
  liveMaster.connect(analyser);

  const transport = Tone.getTransport();
  transport.stop();
  transport.cancel();
  transport.position = 0;
  transport.bpm.value = score.bpm;
  transport.loop = loop;
  transport.loopStart = 0;
  transport.loopEnd = `${score.bars}:0:0`;

  rig.part.start(0);
  transport.start();

  let stopped = false;
  return {
    positionSeconds() {
      if (stopped) return 0;
      // Negative for the instant between starting the transport and the context reaching it.
      return Math.max(0, transport.getSecondsAtTime(Tone.getContext().currentTime));
    },

    spectrum() {
      return stopped ? new Float32Array(128) : analyser.getValue();
    },

    stop() {
      if (stopped) return;
      stopped = true;

      transport.stop();
      transport.cancel();
      transport.loop = false;
      transport.position = 0;

      liveMaster.disconnect(analyser);
      analyser.dispose();
      rig.dispose();
    },
  };
}

export interface RenderOptions {
  /**
   * Seconds of silence kept after the last note, so the tails that Phase 0 spent four rounds
   * tuning are in the file rather than cut off by it. A reverb whose decay is a fraction of a
   * bar needs about that long to finish.
   */
  tailSeconds?: number;
  /**
   * Cut the shareable window out of the piece instead of keeping all of it.
   *
   * The whole piece is still rendered either way, and then sliced. Starting the transport at
   * an offset would be cheaper and would be wrong: the reverb tails and the pad still ringing
   * from the bars before the peak are part of what the peak sounds like, and a clip that
   * began with an empty room would not be the moment it claims to be.
   */
  clip?: boolean;
}

/**
 * Render a Score to a WAV file, faster than real time.
 *
 * The same `buildRig` the speakers get, in an OfflineAudioContext. That is the whole design:
 * a render is not a second implementation that agrees with playback until it does not, it is
 * the same graph asked to run without a clock. The file is what the visitor heard, or the
 * share artifact is a different piece of music wearing its name.
 *
 * Not looped and not started from the middle. `Tone.Offline` gives the callback its own
 * transport, so the loop that live playback wants — and which would otherwise render the
 * piece twice into a buffer sized for one — is simply never switched on.
 */
export interface Rendered {
  sampleRate: number;
  channels: Float32Array[];
}

/**
 * Render a Score offline and return the samples.
 *
 * Separated from the encoder so the WAV and the video are the same audio rather than two
 * renders that agree. The recorder plays these samples back; writing them to a file and
 * playing them into a video are two things done with one result.
 */
export async function renderClip(score: Score, options: RenderOptions = {}): Promise<Rendered> {
  const { tailSeconds = 3, clip = false } = options;
  const duration = scoreDurationSeconds(score) + tailSeconds;

  const buffer = await Tone.Offline(async () => {
    const rig = await buildRig(score);
    const transport = Tone.getTransport();

    transport.bpm.value = score.bpm;
    transport.position = 0;
    rig.part.start(0);
    transport.start();
  }, duration);

  // Tone hands back its own wrapper; the channel data underneath is what the encoder wants.
  const rendered = Array.from({ length: buffer.numberOfChannels }, (_, at) =>
    buffer.getChannelData(at),
  );

  const window = clipWindow(score);
  const channels: Float32Array[] = clip
    ? sliceWithFades(
        rendered,
        buffer.sampleRate,
        window.startSeconds,
        // The tail is kept past the window's end so the fade has real music to fade, rather
        // than fading a silence that was already there.
        window.durationSeconds,
      )
    : rendered.map((channel) => Float32Array.from(channel));

  /*
   * A silent render is the failure this is most likely to have, and the one it would hide
   * best: every promise resolves, the encoder writes a perfectly valid header, and the
   * visitor gets fourteen megabytes of nothing with no way to tell whose fault it is. It
   * would happen if the graph were ever built against the wrong context — the exact mistake
   * the per-context limiter exists to prevent — so the check is here rather than trusted.
   */
  let peak = 0;
  for (const channel of channels) {
    for (const sample of channel) peak = Math.max(peak, Math.abs(sample));
  }
  if (peak < 1e-4) {
    throw new Error('The render came out silent. Nothing was saved.');
  }

  return { sampleRate: buffer.sampleRate, channels };
}

/** The rendered samples as a WAV file. */
export async function renderWav(score: Score, options: RenderOptions = {}): Promise<Blob> {
  const { sampleRate, channels } = await renderClip(score, options);
  return new Blob([encodeWav({ sampleRate, channels })], { type: 'audio/wav' });
}

/**
 * What to call the file.
 *
 * The commit is in the name because the music is a function of it: two files from the same
 * repository at different commits are different pieces, and a name that hid that would put
 * the burden of noticing on whoever had already downloaded one.
 */
export function wavFilename(score: Score, owner: string, name: string, clip = false): string {
  return `codetta-${owner}-${name}-${score.seed}${clip ? '-clip' : ''}.wav`;
}
