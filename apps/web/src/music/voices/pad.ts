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

export function padEvents(skeleton: Skeleton): NoteEvent[] {
  const chords = chordLoop(skeleton);
  const pitchClasses = chords.map((chord) => chord.midi.map((midi) => ((midi % 12) + 12) % 12));
  const voicings = voiceLead(pitchClasses, VOICE_REGISTERS.pad);

  const events: NoteEvent[] = [];
  for (let bar = 0; bar < skeleton.bars; bar++) {
    const voicing = voicings[bar % voicings.length] ?? [];
    for (const midi of voicing) {
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
