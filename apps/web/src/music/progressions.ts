/**
 * Curated chord progressions.
 *
 * These six loops are the harmonic safety net described in docs/music-mapping.md.
 * Everything else in the piece is confined to the active scale, so any melodic
 * material generated on top of these is consonant by construction.
 *
 * Progressions are stored as scale DEGREES, not as chord names, so one entry works
 * across every root. Each entry declares which modes it is valid in — a degree that
 * is a pleasant minor chord in Aeolian can be a diminished triad in Lydian, and a
 * tritone in the pad will wreck the whole track.
 *
 * Adding a progression? Run `pnpm test music/progressions` — the invariant test
 * rejects any entry that produces a diminished or augmented triad in a declared mode.
 */

import { pick } from './palette';

export type ModeName = 'dorian' | 'aeolian' | 'lydian' | 'mixolydian';
export type RootName = 'C' | 'D' | 'Eb' | 'F' | 'G' | 'A';
export type ChordQuality = 'maj' | 'min' | 'dim' | 'aug' | 'other';

/** Every mode here is heptatonic. Anything else is a bug, not a feature. */
const SCALE_DEGREES = 7;

/** Semitone offsets from the tonic, one per scale degree. */
export const MODES: Record<ModeName, readonly number[]> = {
  dorian: [0, 2, 3, 5, 7, 9, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
} as const;

export const ROOT_PITCH_CLASS: Record<RootName, number> = {
  C: 0,
  D: 2,
  Eb: 3,
  F: 5,
  G: 7,
  A: 9,
} as const;

export const MODE_NAMES = Object.keys(MODES) as ModeName[];
export const ROOT_NAMES = Object.keys(ROOT_PITCH_CLASS) as RootName[];

export interface Progression {
  id: string;
  /** One 0-indexed scale degree per bar. Always exactly four bars. */
  bars: readonly [number, number, number, number];
  /** Modes this progression is verified to be free of diminished triads in. */
  modes: readonly ModeName[];
  /** Human-facing note. Not read by any code — it exists so review is possible. */
  feel: string;
}

export const PROGRESSIONS: readonly Progression[] = [
  {
    id: 'nightfall',
    bars: [0, 5, 2, 6],
    modes: ['aeolian'],
    feel: 'i ♭VI ♭III ♭VII — the familiar minor loop. Safest option in the set.',
  },
  {
    id: 'undertow',
    bars: [0, 6, 5, 6],
    modes: ['aeolian'],
    feel: 'i ♭VII ♭VI ♭VII — never resolves. Good under dense, busy repos.',
  },
  {
    id: 'meadow',
    bars: [0, 3, 0, 6],
    modes: ['dorian'],
    feel: 'i IV i ♭VII — leans on the major IV that makes Dorian sound like Dorian.',
  },
  {
    id: 'current',
    bars: [0, 4, 6, 3],
    modes: ['dorian', 'aeolian', 'mixolydian'],
    feel:
      'i v ♭VII IV in Dorian and Mixolydian; the last chord is a minor iv in Aeolian. ' +
      'Modal and rootless-feeling. The most versatile entry.',
  },
  {
    id: 'daylight',
    bars: [0, 6, 3, 0],
    modes: ['mixolydian'],
    feel: 'I ♭VII IV I — bright without being saccharine.',
  },
  {
    id: 'updraft',
    bars: [0, 1, 5, 4],
    modes: ['lydian'],
    feel:
      'I II vi V — floating. The only Lydian entry, deliberately: Lydian has a ' +
      'diminished ♯iv that most loops walk straight into.',
  },
] as const;

const PITCH_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

/** MIDI 60 → "C4". */
export function midiToNote(midi: number): string {
  const pc = ((midi % 12) + 12) % 12;
  return `${pick(PITCH_NAMES, pc)}${Math.floor(midi / 12) - 1}`;
}

/**
 * Semitone offset of a scale degree from the tonic. Degrees above 6 or below 0
 * wrap into the next octave, so degree 9 is degree 2 an octave up.
 */
function degreeToSemitone(scale: readonly number[], degree: number): number {
  const octave = Math.floor(degree / SCALE_DEGREES);
  const index = ((degree % SCALE_DEGREES) + SCALE_DEGREES) % SCALE_DEGREES;
  const semitone = scale[index];
  if (semitone === undefined) {
    throw new Error(`A mode must have ${SCALE_DEGREES} degrees, got ${scale.length}.`);
  }
  return semitone + octave * 12;
}

/**
 * Pitch class (0–11) of a scale degree in a given key. Degrees wrap, so degree 7 is the
 * tonic again an octave up.
 *
 * This is the only sanctioned way to turn a degree into a note. Callers choose a degree;
 * they never choose a semitone. That is what keeps every voice inside the active scale by
 * construction rather than by a check after the fact.
 */
export function degreePitchClass(mode: ModeName, root: RootName, degree: number): number {
  const semitone = ROOT_PITCH_CLASS[root] + degreeToSemitone(MODES[mode], degree);
  return ((semitone % 12) + 12) % 12;
}

/**
 * MIDI note of a scale degree, counting from the tonic in `octave`. Degrees run in both
 * directions without limit: degree 7 is the tonic an octave up, degree −1 the seventh below.
 *
 * Melodic voices use this rather than {@link degreePitchClass} because a melody is defined
 * by the interval between consecutive notes. Choosing a pitch class and then placing it in
 * the nearest octave throws that contour away — two adjacent degrees can land a seventh
 * apart — and the result is a random walk rather than a line.
 */
export function degreeToMidi(
  mode: ModeName,
  root: RootName,
  degree: number,
  octave: number,
): number {
  return 12 * (octave + 1) + ROOT_PITCH_CLASS[root] + degreeToSemitone(MODES[mode], degree);
}

function qualityOf(intervals: readonly number[]): ChordQuality {
  const [rootMidi, thirdMidi, fifthMidi] = intervals;
  if (rootMidi === undefined || thirdMidi === undefined || fifthMidi === undefined) {
    return 'other';
  }
  const third = thirdMidi - rootMidi;
  const fifth = fifthMidi - rootMidi;
  if (third === 4 && fifth === 7) return 'maj';
  if (third === 3 && fifth === 7) return 'min';
  if (third === 3 && fifth === 6) return 'dim';
  if (third === 4 && fifth === 8) return 'aug';
  return 'other';
}

export interface RealizedChord {
  degree: number;
  quality: ChordQuality;
  /** Tone.js note names, low to high. */
  notes: string[];
  /** MIDI numbers, low to high. Use these for voice-leading maths. */
  midi: number[];
}

export interface RealizeOptions {
  /** Octave of the tonic. 3 puts the pad in a comfortable register. */
  octave?: number;
  /** Stack the diatonic seventh. Warmer, but muddier below C3. */
  seventh?: boolean;
}

/**
 * Turn a progression into four bars of concrete chords.
 *
 * Pure. Given the same arguments it always returns the same notes — this is part of
 * the determinism guarantee in CLAUDE.md, so do not introduce randomness here.
 */
export function realizeProgression(
  progression: Progression,
  mode: ModeName,
  root: RootName,
  options: RealizeOptions = {},
): RealizedChord[] {
  const { octave = 3, seventh = false } = options;

  if (!progression.modes.includes(mode)) {
    throw new Error(
      `Progression "${progression.id}" is not verified in ${mode}. ` +
        `Use pickProgression() rather than selecting by hand.`,
    );
  }

  const scale = MODES[mode];
  const tonicMidi = 12 * (octave + 1) + ROOT_PITCH_CLASS[root];
  const stack = seventh ? [0, 2, 4, 6] : [0, 2, 4];

  return progression.bars.map((degree) => {
    const midi = stack.map((offset) => tonicMidi + degreeToSemitone(scale, degree + offset));
    return {
      degree,
      quality: qualityOf(midi),
      midi,
      notes: midi.map(midiToNote),
    };
  });
}

/**
 * Deterministically choose a progression that is valid in the given mode.
 * `rng` must be the seeded PRNG from music/rng.ts — never Math.random.
 */
export function pickProgression(mode: ModeName, rng: () => number): Progression {
  const candidates = PROGRESSIONS.filter((p) => p.modes.includes(mode));
  if (candidates.length === 0) {
    throw new Error(`No progression is verified in ${mode}.`);
  }
  // pick() clamps, so an rng that violates its [0, 1) contract biases selection rather
  // than crashing mid-render.
  return pick(candidates, rng() * candidates.length);
}

/**
 * Every (progression, mode) pair the selector can produce. Exported for the
 * invariant test — a diminished or augmented triad anywhere in here is a bug.
 */
export function allValidPairs(): Array<{ progression: Progression; mode: ModeName }> {
  return PROGRESSIONS.flatMap((progression) =>
    progression.modes.map((mode) => ({ progression, mode })),
  );
}
