import { PHRASE_ACTIVE_TICKS, PHRASE_TICKS, type VoiceContext } from '../arrangement';
import { branchingPosition, clamp } from '../calibration';
import { pick } from '../palette';
import { unitHash } from '../rng';
import { TICKS_PER_BAR, VOICE_REGISTERS, barToTick, type NoteEvent } from '../score';
import { chordLoop } from '../skeleton';
import { placementsInRange } from '../voicing';

/**
 * Rank 2: runs the chord tones.
 *
 * Deliberately not a second melody. The lead already states a motif, and two tunes at once
 * is one too many — the arp's job is motion under it, which is why it is a fixed figure over
 * the harmony rather than anything that chooses pitches for itself. It restarts on every bar
 * so the chord change is audible in the figure, and it rests on the same grid as the lead so
 * both voices breathe together.
 *
 * The arp's register is one octave, C4–C5. That is why nothing here reads avgNestingDepth:
 * the octave mapping in Layer 3 has nothing to select from, so pretending otherwise would be
 * inventing a meaning the spec does not give it.
 */

/**
 * Figures over the bar's chord tones, low to high. Curated rather than generated: an
 * arpeggio is recognisable precisely because its shape is fixed, so there is nothing for
 * randomness to improve.
 */
const ARP_PATTERNS: ReadonlyArray<readonly number[]> = [
  [0, 1, 2, 1],
  [0, 1, 2, 2],
  [2, 1, 0, 1],
  [0, 2, 1, 2],
  [0, 1, 0, 2],
  [0, 2, 1, 0],
];

/** Ticks between notes: quarter, eighth, eighth, sixteenth. Busier repos run faster. */
const ARP_RATES = [4, 2, 2, 1] as const;

/** The bar's chord, placed low to high inside the arp's octave. */
function chordTonesIn(midiOfChord: readonly number[], lo: number, hi: number): number[] {
  const placed = midiOfChord
    .map((midi) => placementsInRange(midi, lo, hi)[0])
    .filter((midi): midi is number => midi !== undefined);
  return [...new Set(placed)].sort((a, b) => a - b);
}

export function arpEvents(context: VoiceContext): NoteEvent[] {
  const { skeleton, module } = context;
  const [lo, hi] = VOICE_REGISTERS.arp;

  const chords = chordLoop(skeleton);
  const rate = pick(ARP_RATES, branchingPosition(module) * ARP_RATES.length);
  const pattern = pick(ARP_PATTERNS, unitHash(module.path) * ARP_PATTERNS.length);
  // Background, so quieter than the lead at the same module size.
  const velocity = clamp(0.32 + module.share * 0.5, 0.28, 0.6);

  const totalTicks = barToTick(skeleton.bars);
  const events: NoteEvent[] = [];

  for (let tick = 0; tick < totalTicks; tick += rate) {
    if (tick % PHRASE_TICKS >= PHRASE_ACTIVE_TICKS) continue;

    const bar = Math.floor(tick / TICKS_PER_BAR);
    const chord = chords[bar % chords.length];
    if (!chord) continue;

    const tones = chordTonesIn(chord.midi, lo, hi);
    if (tones.length === 0) continue;

    // Restart on the bar, so the figure spells out each chord rather than running across it.
    const stepInBar = (tick % TICKS_PER_BAR) / rate;
    const midi = tones[(pattern[stepInBar % pattern.length] ?? 0) % tones.length];
    if (midi === undefined) continue;

    // Each note ends where the next begins: the arp is one line, and overlapping it would
    // spend polyphony on a voice whose job is motion rather than harmony.
    const durationTicks = Math.max(
      1,
      Math.min(rate, PHRASE_ACTIVE_TICKS - (tick % PHRASE_TICKS), totalTicks - tick),
    );

    events.push({ voice: 'arp', tick, durationTicks, midi, velocity });
  }

  return events;
}
