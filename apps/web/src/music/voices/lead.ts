import { PHRASE_ACTIVE_TICKS, PHRASE_TICKS, type VoiceContext } from '../arrangement';
import {
  branchingPosition,
  clamp,
  functionLengthPosition,
  nestingPosition,
} from '../calibration';
import { pick } from '../palette';
import { degreeToMidi } from '../progressions';
import { unitHash } from '../rng';
import { TICKS_PER_BAR, VOICE_REGISTERS, barToTick, type NoteEvent } from '../score';
import { chordLoop } from '../skeleton';

/**
 * Rank 1: the largest module gets the most prominent voice.
 *
 * The lead states a two-bar motif and then restates it. That is the whole idea. Notes drawn
 * fresh for forty bars are a random walk over the scale even when every interval is
 * stepwise and every pitch is in key — there is nothing for a listener to hold on to, and
 * it reads as busy no matter how few notes there are. Repetition is what turns pitches into
 * a tune, and it is also what makes the line feel calm.
 *
 * Every feature here selects an index or a probability. None reaches a MIDI number, a
 * frequency or a millisecond: the lead chooses scale degrees and the key decides the notes.
 */

/**
 * AABA over eight bars: state it, confirm it, answer it, resolve it. The oldest melodic
 * form there is, and the reason is that a listener needs the third hearing before the
 * contrast means anything.
 */
const PHRASE_FORM = ['a', 'a', 'b', 'a'] as const;

/**
 * Curated rhythms, one per density step, ordered from sparse to busy. A palette rather than
 * a per-16th coin flip: a memoryless probability produces rhythms that are merely irregular,
 * and irregular is not the same as syncopated. Every entry starts on the downbeat so the
 * phrase has a floor, and none crosses into the rest.
 *
 * The floor is five onsets, and it used to be three. Three notes across two bars is not a
 * lead — it is below the rate the arp runs at, in the voice Layer 2 calls the most active
 * one — and it fails in both directions at once. Short notes at that rate are hollow; long
 * notes at that rate drag. Both were heard on facebook/react, whose largest module is flat
 * DOM plumbing and lands at the bottom of this palette. There is no note length that rescues
 * three onsets, because the problem is the rate rather than the sustain, which is why this
 * moved rather than the articulation.
 *
 * That the fix compounds with articulation is the useful part: more onsets means smaller
 * gaps, and a gap-relative note length is shorter automatically. Raising the rate makes the
 * line move without making it heavier.
 *
 * The two busiest entries are deliberately untouched — nothing reported a problem at that
 * end, and psf/requests sits on the second of them.
 */
const RHYTHMS: ReadonlyArray<readonly number[]> = [
  [0, 4, 8, 12, 16],
  [0, 4, 6, 12, 16],
  [0, 4, 6, 8, 16],
  [0, 2, 4, 8, 16, 20],
  [0, 3, 6, 8, 11, 16],
  [0, 4, 6, 8, 12, 16],
  [0, 2, 4, 8, 12, 16],
  [0, 2, 6, 8, 12, 16, 20],
];

/**
 * How much of the space before the next onset a note fills. Longer functions, longer notes —
 * the mapping docs/music-mapping.md asks for, expressed as articulation rather than as an
 * absolute number of ticks.
 *
 * Absolute durations do not work here, and the reason is the correlation in
 * music/calibration.ts. Function length, nesting and branching move together, so the repos
 * that select a sparse rhythm also select the short end of any absolute duration palette:
 * react's lead came out three notes per two bars, each a sixteenth, which is a quarter of a
 * second of sound and one and a half seconds of silence, over and over. Empty rather than
 * calm. At the other end the effect vanished instead — a busy rhythm's notes were already
 * being cut short by the next onset, so the long buckets were unreachable.
 *
 * As a fraction of the gap, the same feature means the same thing at both ends: sparse
 * rhythms sustain and busy ones are clipped, which is also how a player would phrase them.
 */
const ARTICULATIONS = [0.5, 0.7, 0.85, 1] as const;

/**
 * Steps the contour may take, in scale degrees. Stepwise motion dominates because that is
 * what makes a line singable; nothing leaps more than a fifth.
 */
const CONTOUR_STEPS = [-4, -3, -2, -2, -1, -1, -1, -1, 1, 1, 1, 1, 2, 2, 3, 4] as const;

/** How far a motif may roam from its own first note, in scale degrees. */
const CONTOUR_RANGE = 5;

/** Weight on staying in the module's register when anchoring a phrase, against smoothness. */
const REGISTER_PULL = 0.5;

/** Room left below the register ceiling for the motif to rise into, in semitones. */
const HEADROOM = 4;

/**
 * The band within the lead's register that nesting may place the line in.
 *
 * Not the whole register, in either direction, and both ends were audible.
 *
 * The floor is the top of the pad's register. The lead's register starts at C4 and the pad's
 * runs to C5, so a lead targeted at the bottom of its own register is not overlapping the
 * pad — it is inside it. facebook/react's nesting sits near zero, which parked its lead at
 * 60–72 against a pad voiced 53–70, and it turned to mud exactly as you would expect of two
 * voices sharing a register and a chord. The lower half of the register is where the contour
 * may reach; it is not where the line should live.
 *
 * The ceiling is held back for the mirror reason. psf/requests pins nesting at the maximum,
 * which put its target on C6 — the top note of the register, so every motif could only move
 * downwards from it, and the line sat at the very edge of the instrument all piece.
 */
export const TARGET_BAND: readonly [number, number] = [
  VOICE_REGISTERS.pad[1],
  VOICE_REGISTERS.lead[1] - HEADROOM,
];

/**
 * Degree offsets from the phrase anchor, one per onset. Generated once and reused, which is
 * what makes it a motif rather than a sequence of notes. The last offset returns to the
 * anchor so every phrase resolves onto a chord tone.
 */
function buildContour(length: number, salt: string): number[] {
  const offsets = [0];
  for (let i = 1; i < length - 1; i++) {
    const previous = offsets[i - 1] ?? 0;
    const step = pick(CONTOUR_STEPS, unitHash(`${salt}#${i}`) * CONTOUR_STEPS.length);
    offsets.push(clamp(previous + step, -CONTOUR_RANGE, CONTOUR_RANGE));
  }
  if (length > 1) offsets.push(0);
  return offsets;
}

/**
 * The B phrase is A turned upside down, not a second contour from a second hash.
 *
 * Hashing B independently made the contrast a coincidence rather than a property, and on the
 * sparsest rhythm the coincidence stops happening: three onsets means one free step, one
 * free step means one of two directions, so half of all repositories got a B identical to
 * their A and the form quietly collapsed to AAAA. That went unnoticed for as long as it did
 * because the fixture the tests ran on was hand-authored with a branching figure ten times
 * anything real, which put every repository on the busiest rhythm in the palette.
 *
 * Inversion is also the better answer musically. An independent contour is a second idea;
 * the same idea mirrored is an answer to the first, which is what the B of an AABA is for.
 */
function invert(contour: readonly number[]): number[] {
  return contour.map((offset) => -offset);
}

export function leadEvents(context: VoiceContext): NoteEvent[] {
  const { skeleton, module, timeline } = context;
  const [lo, hi] = VOICE_REGISTERS.lead;

  const chords = chordLoop(skeleton);
  const midiOf = (degree: number) => degreeToMidi(skeleton.mode, skeleton.root, degree, 4);

  const rhythm = pick(RHYTHMS, branchingPosition(module) * RHYTHMS.length);
  const articulation = pick(
    ARTICULATIONS,
    functionLengthPosition(module) * ARTICULATIONS.length,
  );
  // Deeper nesting sits higher, inside the band rather than across the whole register.
  const [bandLo, bandHi] = TARGET_BAND;
  const target = bandLo + (bandHi - bandLo) * nestingPosition(module);
  // Bigger module, louder voice.
  const velocity = clamp(0.45 + module.share * 0.6, 0.4, 0.8);

  // Motifs are hashed from the repo's own files, so two repos get different tunes and the
  // same repo gets the same one forever.
  const salt =
    timeline
      .slice(0, 8)
      .map((entry) => entry.path)
      .join('|') || module.path;
  const a = buildContour(rhythm.length, `${salt}#a`);
  const contours = { a, b: invert(a) };

  const totalTicks = barToTick(skeleton.bars);
  const events: NoteEvent[] = [];
  let previousMidi = target;

  for (let phraseStart = 0; phraseStart < totalTicks; phraseStart += PHRASE_TICKS) {
    const phraseIndex = phraseStart / PHRASE_TICKS;
    const form = PHRASE_FORM[phraseIndex % PHRASE_FORM.length] ?? 'a';
    const contour = contours[form];

    const bar = Math.floor(phraseStart / TICKS_PER_BAR);
    const chordDegree = chords[bar % chords.length]?.degree ?? 0;

    // Anchor on a chord tone, close to where the last phrase left off so the phrases join,
    // but pulled back toward the module's register so the line cannot drift away over
    // forty bars.
    let anchor = chordDegree;
    let bestScore = Infinity;
    for (const tone of [0, 2, 4]) {
      for (let octave = -2; octave <= 2; octave++) {
        const candidate = chordDegree + tone + octave * 7;
        const midi = midiOf(candidate);
        if (midi < lo || midi > hi) continue;
        const score = Math.abs(midi - previousMidi) + REGISTER_PULL * Math.abs(midi - target);
        if (score < bestScore) {
          bestScore = score;
          anchor = candidate;
        }
      }
    }

    for (const [i, onset] of rhythm.entries()) {
      const tick = phraseStart + onset;
      if (tick >= totalTicks) break;

      let degree = anchor + (contour[i] ?? 0);
      for (let guard = 0; guard < 8 && midiOf(degree) < lo; guard++) degree += 7;
      for (let guard = 0; guard < 8 && midiOf(degree) > hi; guard++) degree -= 7;
      const midi = midiOf(degree);
      if (midi < lo || midi > hi) continue;

      // Space before the next onset, the phrase's rest, or the end of the piece — whichever
      // comes first. A note may fill it and never exceed it, which is what keeps the line
      // monophonic and keeps the rest silent without either being checked for separately.
      const nextOnset = rhythm[i + 1] ?? PHRASE_ACTIVE_TICKS;
      const available = Math.min(
        nextOnset - onset,
        PHRASE_ACTIVE_TICKS - onset,
        totalTicks - tick,
      );
      if (available <= 0) continue;
      const durationTicks = Math.max(1, Math.round(available * articulation));

      events.push({ voice: 'lead', tick, durationTicks, midi, velocity });
      previousMidi = midi;
    }
  }

  return events;
}
