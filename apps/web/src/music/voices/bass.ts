import { TICKS_PER_BEAT, VOICE_REGISTERS, barToTick, type NoteEvent } from '../score';
import { chordLoop, type Skeleton } from '../skeleton';
import { placementsInRange } from '../voicing';

/**
 * Root of the current chord on beats 1 and 3. Like the pad, it reads no repo feature.
 */

const BASS_VELOCITY = 0.75;

/** Beats 1 and 3 of a 4/4 bar, zero-indexed. */
const ACCENT_BEATS = [0, 2];

/**
 * A 16th short of half a bar. The gap matters: without it two identical roots in a row
 * smear into one sustained note and the pulse disappears.
 */
const BASS_DURATION_TICKS = TICKS_PER_BEAT * 2 - 1;

export function bassEvents(skeleton: Skeleton): NoteEvent[] {
  const [lo, hi] = VOICE_REGISTERS.bass;
  const roots = chordLoop(skeleton).map((chord) => {
    const rootMidi = chord.midi[0];
    if (rootMidi === undefined) {
      throw new Error(`Chord on degree ${chord.degree} has no root.`);
    }
    const placement = placementsInRange(rootMidi, lo, hi)[0];
    if (placement === undefined) {
      throw new Error(`Root of degree ${chord.degree} does not fit in ${lo}–${hi}.`);
    }
    return placement;
  });

  const events: NoteEvent[] = [];
  for (let bar = 0; bar < skeleton.bars; bar++) {
    const midi = roots[bar % roots.length];
    if (midi === undefined) continue;
    for (const beat of ACCENT_BEATS) {
      events.push({
        voice: 'bass',
        tick: barToTick(bar) + beat * TICKS_PER_BEAT,
        durationTicks: BASS_DURATION_TICKS,
        midi,
        velocity: BASS_VELOCITY,
      });
    }
  }
  return events;
}
