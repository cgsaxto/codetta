import type { VoiceContext } from '../arrangement';
import { commentPosition } from '../calibration';
import { degreeToMidi } from '../progressions';
import {
  TICKS_PER_BAR,
  VOICE_REGISTERS,
  barToTick,
  type NoteEvent,
  type VoiceTimbre,
} from '../score';
import { placementsInRange } from '../voicing';

/**
 * Rank 4: a sustained pedal on the tonic, low and filtered.
 *
 * It holds the tonic rather than following the chords. Two reasons. The pad already voices
 * every chord, so a second voice tracking the same harmony in the same register only adds
 * weight to what is there; and a pedal cannot clash with a loop that never leaves its own
 * mode, which makes this the one voice that is safe to leave running underneath everything.
 *
 * It does not stop for the phrase rest. Like the pad and the bass it is a bed, not a
 * foreground voice — a drone that breaks every two bars is not a drone.
 */

/** Quiet. This voice is felt rather than heard; at any volume where it is audible as a
 * note it has become a second bass. */
const TEXTURE_VELOCITY = 0.22;

/**
 * More comments, more open and airier. The only feature that reaches timbre, and it stays
 * normalised — audio/ owns the cutoff palette this indexes into.
 */
export function textureTimbre(context: VoiceContext): VoiceTimbre {
  return { openness: commentPosition(context.module) };
}

export function textureEvents(context: VoiceContext): NoteEvent[] {
  const { skeleton } = context;
  const [lo, hi] = VOICE_REGISTERS.texture;

  const tonic = degreeToMidi(skeleton.mode, skeleton.root, 0, 3);
  const midi = placementsInRange(tonic, lo, hi)[0];
  if (midi === undefined) return [];

  const totalTicks = barToTick(skeleton.bars);
  const events: NoteEvent[] = [];

  // Re-struck each bar rather than held for the whole piece: one note lasting ninety
  // seconds gives the envelope nothing to do, and the slow re-attack is the movement.
  for (let tick = 0; tick < totalTicks; tick += TICKS_PER_BAR) {
    events.push({
      voice: 'texture',
      tick,
      durationTicks: Math.min(TICKS_PER_BAR, totalTicks - tick),
      midi,
      velocity: TEXTURE_VELOCITY,
    });
  }

  return events;
}
