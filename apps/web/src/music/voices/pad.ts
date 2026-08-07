import { TICKS_PER_BAR, VOICE_REGISTERS, barToTick, type NoteEvent } from '../score';
import { chordLoop, type Skeleton } from '../skeleton';
import { voiceLead } from '../voicing';

/**
 * The pad plays the chord loop and nothing else. It reads no repo feature at all — it and
 * the bass are the safety net that makes every other voice work, so nothing about the code
 * being sonified is allowed to reach them.
 */

/** Quiet enough that four sustained notes leave headroom for everything above. */
const PAD_VELOCITY = 0.32;

/**
 * Below middle C the third is dropped and the pad plays an open fifth instead.
 *
 * The third is the interval that names a chord major or minor, and it is also the one that
 * turns to mud low down: two voices a third apart around 170 Hz beat against each other
 * rather than blending. Above middle C it is clear and worth keeping. Below it, an open
 * fifth is cleaner, and the mode is already carried by the bass and by the progression —
 * so nothing about the harmony is actually lost.
 */
const THIRD_FLOOR = 60;

function pitchClassOf(midi: number): number {
  return ((midi % 12) + 12) % 12;
}

export function padEvents(skeleton: Skeleton): NoteEvent[] {
  const chords = chordLoop(skeleton);
  const pitchClasses = chords.map((chord) => chord.midi.map(pitchClassOf));
  // Voice-lead the complete triad, then drop notes. Leading on the reduced chord instead
  // would let the remaining voices wander whenever a third came and went.
  const voicings = voiceLead(pitchClasses, VOICE_REGISTERS.pad);

  const events: NoteEvent[] = [];
  for (let bar = 0; bar < skeleton.bars; bar++) {
    const index = bar % voicings.length;
    const voicing = voicings[index] ?? [];
    // realizeProgression stacks root, third, fifth, so index 1 is always the third.
    const thirdMidi = chords[index]?.midi[1];
    const thirdClass = thirdMidi === undefined ? -1 : pitchClassOf(thirdMidi);

    for (const midi of voicing) {
      if (midi < THIRD_FLOOR && pitchClassOf(midi) === thirdClass) continue;
      events.push({
        voice: 'pad',
        tick: barToTick(bar),
        // Held for the whole bar: the next chord takes over exactly where this one ends.
        durationTicks: TICKS_PER_BAR,
        midi,
        velocity: PAD_VELOCITY,
      });
    }
  }
  return events;
}
