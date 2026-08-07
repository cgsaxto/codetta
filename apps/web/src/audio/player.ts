import * as Tone from 'tone';
import {
  BEATS_PER_BAR,
  TICKS_PER_BAR,
  TICKS_PER_BEAT,
  type NoteEvent,
  type Score,
} from '../music/score';
import { masterBus } from './engine';

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
}

export interface PlaybackOptions {
  /** Repeat the piece. The roadmap gate is whether pad and bass are pleasant on loop. */
  loop?: boolean;
}

export async function startPlayback(
  score: Score,
  options: PlaybackOptions = {},
): Promise<Player> {
  const { loop = true } = options;

  await Tone.start();
  const master = masterBus();

  // Envelope times are fractions of a bar, not fixed seconds. Tempo is repo-dependent, so
  // a fixed release that crossfades nicely at 116 BPM piles chords up at 72.
  const barSeconds = (60 / score.bpm) * BEATS_PER_BAR;

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
    frequency: 2600,
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
    oscillator: { type: 'triangle' },
    envelope: {
      attack: barSeconds * 0.1,
      decay: barSeconds * 0.25,
      sustain: 0.7,
      // Must stay well under one bar. Longer, and each chord is still sounding when the
      // next two arrive, which makes the Score's 8-note ceiling a fiction acoustically.
      release: barSeconds * 0.35,
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
    oscillator: { type: 'triangle' },
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
      octaves: 3.2,
    },
  }).connect(bassGain);

  // The impulse response is generated asynchronously; starting first gives a dry opening bar.
  await padReverb.ready;

  const part = new Tone.Part<ScheduledNote>(
    (time, note) => {
      const instrument = note.voice === 'bass' ? bass : pad;
      instrument.triggerAttackRelease(
        Tone.Frequency(note.midi, 'midi').toFrequency(),
        ticksToTransportTime(note.durationTicks),
        time,
        note.velocity,
      );
    },
    score.events.map((event) => ({ ...event, time: ticksToTransportTime(event.tick) })),
  );

  const transport = Tone.getTransport();
  transport.stop();
  transport.cancel();
  transport.position = 0;
  transport.bpm.value = score.bpm;
  transport.loop = loop;
  transport.loopStart = 0;
  transport.loopEnd = `${score.bars}:0:0`;

  part.start(0);
  transport.start();

  let stopped = false;
  return {
    stop() {
      if (stopped) return;
      stopped = true;

      transport.stop();
      transport.cancel();
      transport.loop = false;
      transport.position = 0;

      pad.releaseAll();
      part.dispose();
      for (const node of [pad, padHighpass, padFilter, padReverb, padGain, bass, bassGain]) {
        node.dispose();
      }
    },
  };
}
