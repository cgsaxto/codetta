import * as Tone from 'tone';
import { TICKS_PER_BAR, TICKS_PER_BEAT, type NoteEvent, type Score } from '../music/score';
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

  const padGain = new Tone.Gain(Tone.dbToGain(-15)).connect(master);
  const padReverb = new Tone.Reverb({ decay: 6, wet: 0.32 }).connect(padGain);
  const padFilter = new Tone.Filter({
    frequency: 1600,
    type: 'lowpass',
    rolloff: -12,
  }).connect(padReverb);
  const pad = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'triangle' },
    // Slow in, slow out. A pad that speaks immediately reads as an organ, not a pad.
    envelope: { attack: 0.9, decay: 0.5, sustain: 0.75, release: 2.4 },
  }).connect(padFilter);

  const bassGain = new Tone.Gain(Tone.dbToGain(-9)).connect(master);
  const bassFilter = new Tone.Filter({
    frequency: 900,
    type: 'lowpass',
    rolloff: -12,
  }).connect(bassGain);
  const bass = new Tone.Synth({
    // Triangle rather than sine: C1 is 33 Hz, and the harmonics are what make it audible
    // on anything that is not a pair of studio monitors.
    oscillator: { type: 'triangle' },
    envelope: { attack: 0.02, decay: 0.35, sustain: 0.55, release: 0.35 },
  }).connect(bassFilter);

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
      for (const node of [pad, padFilter, padReverb, padGain, bass, bassFilter, bassGain]) {
        node.dispose();
      }
    },
  };
}
