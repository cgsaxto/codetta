import { PHRASE_ACTIVE_TICKS, PHRASE_TICKS, type VoiceContext } from '../arrangement';
import { branchingPosition, clamp } from '../calibration';
import { pick } from '../palette';
import { unitHash } from '../rng';
import { TICKS_PER_BAR, VOICE_REGISTERS, barToTick, type NoteEvent } from '../score';
import { chordLoop } from '../skeleton';
import { placementsInRange } from '../voicing';

/**
 * Rank 3: sparse accents, high up.
 *
 * At most two notes in two bars. The temptation with a bell is to give it something to
 * play, and that is exactly wrong — a bell earns its place by being rare enough that each
 * strike registers. Anything more often and it stops being an accent and becomes another
 * line competing with the lead.
 *
 * Like the arp, its register is a single octave, so avgNestingDepth has nothing to choose.
 */

/**
 * Accent positions inside a two-bar phrase, ordered from sparse to less sparse. Density
 * selects one; nothing here is ever busier than one strike a bar.
 */
const BELL_ACCENTS: ReadonlyArray<readonly number[]> = [
  [0],
  [16],
  [8],
  [0, 16],
  [8, 16],
  [0, 12],
];

/** Struck, so it rings. Clamped to the phrase so the tail is decay rather than new notes. */
const BELL_DURATION_TICKS = 8;

export function bellEvents(context: VoiceContext): NoteEvent[] {
  const { skeleton, module } = context;
  const [lo, hi] = VOICE_REGISTERS.bell;

  const chords = chordLoop(skeleton);
  const accents = pick(BELL_ACCENTS, branchingPosition(module) * BELL_ACCENTS.length);
  // Quietest of the pitched voices: an accent works by being noticed, not by being loud.
  const velocity = clamp(0.3 + module.share * 0.5, 0.25, 0.55);

  const totalTicks = barToTick(skeleton.bars);
  const events: NoteEvent[] = [];

  for (let phraseStart = 0; phraseStart < totalTicks; phraseStart += PHRASE_TICKS) {
    for (const offset of accents) {
      const tick = phraseStart + offset;
      if (tick >= totalTicks) continue;

      const bar = Math.floor(tick / TICKS_PER_BAR);
      const chord = chords[bar % chords.length];
      if (!chord) continue;

      /**
       * A tone the current chord shares with the next one, where such a tone exists.
       *
       * A bell rings far longer than the bar it was struck in — that is what makes it a
       * bell — so by the time it fades the harmony underneath has already moved. Striking
       * a tone the two chords have in common means it is still a chord tone when that
       * happens. Without it the bell reads as very slightly out of tune, in the most
       * exposed register in the mix, where there is nothing to hide behind.
       *
       * Not every progression offers one: `undertow` is i–♭VII–♭VI–♭VII, and no two
       * adjacent chords in it share a note at all. There the strike falls back to the
       * current chord and the shortened decay does the work instead.
       */
      const nextChord = chords[(bar + 1) % chords.length];
      const nextClasses = new Set(nextChord?.midi.map((midi) => ((midi % 12) + 12) % 12));
      const shared = chord.midi.filter((midi) => nextClasses.has(((midi % 12) + 12) % 12));

      const tones = (shared.length > 0 ? shared : chord.midi)
        .map((midi) => placementsInRange(midi, lo, hi)[0])
        .filter((midi): midi is number => midi !== undefined);
      if (tones.length === 0) continue;
      const midi = pick(tones, unitHash(`${module.path}#${tick}`) * tones.length);

      const durationTicks = Math.max(
        1,
        Math.min(
          BELL_DURATION_TICKS,
          PHRASE_ACTIVE_TICKS - (tick % PHRASE_TICKS),
          totalTicks - tick,
        ),
      );
      events.push({ voice: 'bell', tick, durationTicks, midi, velocity });
    }
  }

  return events;
}
