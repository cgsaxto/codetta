import type { RepoFeatures } from '@codetta/schema';
import { pick } from './palette';
import {
  MODE_NAMES,
  ROOT_NAMES,
  pickProgression,
  realizeProgression,
  type ModeName,
  type Progression,
  type RealizeOptions,
  type RealizedChord,
  type RootName,
} from './progressions';
import { createRng } from './rng';
import {
  MAX_BPM,
  SECTION_ORDER,
  sortEvents,
  type NoteEvent,
  type Score,
  type Section,
  type VoiceId,
  type VoiceTimbre,
} from './score';

/**
 * Layer 1 and Layer 4 of docs/music-mapping.md: the fixed skeleton every repo is poured
 * into. Nothing here reads a feature magnitude except tempo, and tempo only selects an
 * index into a palette.
 */

/**
 * Renaming this changes the key, mode and chord loop of every repo ever rendered. It is
 * part of the output contract, not a label.
 */
const SKELETON_STREAM = 'skeleton';

/** 72–128 BPM in 4 BPM steps. Fifteen entries, and never a computed value between them. */
export const TEMPOS = [
  72, 76, 80, 84, 88, 92, 96, 100, 104, 108, 112, 116, 120, 124, 128,
] as const;

/**
 * Repo sizes span four orders of magnitude, so size maps to tempo on a log scale:
 * 1k LOC lands at the slowest tempo, 1M at the fastest.
 */
export function tempoIndexFor(linesOfCode: number): number {
  const decades = Math.log10(Math.max(linesOfCode, 1)) - 3;
  return Math.round((decades / 3) * (TEMPOS.length - 1));
}

export function tempoFor(linesOfCode: number): number {
  return pick(TEMPOS, tempoIndexFor(linesOfCode));
}

interface StructureTemplate {
  /** Highest tempo this template serves. Bands are contiguous and cover all of TEMPOS. */
  readonly maxBpm: number;
  readonly bars: number;
  readonly sectionBars: Readonly<Record<(typeof SECTION_ORDER)[number], number>>;
}

/**
 * A fixed bar count cannot work: 40 bars at 72 BPM is 133 seconds, and the piece has to
 * land in 60–90 s. Slower tempo, fewer bars. Every section is a multiple of 4 bars so it
 * begins on the tonic chord of the 4-bar loop.
 */
const TEMPLATES: readonly StructureTemplate[] = [
  {
    maxBpm: 84,
    bars: 24,
    sectionBars: { intro: 4, build: 4, peak: 4, break: 4, return: 4, outro: 4 },
  },
  {
    maxBpm: 104,
    bars: 32,
    sectionBars: { intro: 4, build: 4, peak: 8, break: 4, return: 8, outro: 4 },
  },
  {
    maxBpm: MAX_BPM,
    bars: 40,
    sectionBars: { intro: 4, build: 8, peak: 12, break: 4, return: 8, outro: 4 },
  },
];

export interface Structure {
  bars: number;
  sections: Section[];
}

export function structureFor(bpm: number): Structure {
  const template = TEMPLATES.find((candidate) => bpm <= candidate.maxBpm);
  if (!template) {
    throw new Error(`No structure template for ${bpm} BPM — the ceiling is ${MAX_BPM}.`);
  }

  let startBar = 0;
  const sections = SECTION_ORDER.map((name) => {
    const bars = template.sectionBars[name];
    const section: Section = { name, startBar, bars };
    startBar += bars;
    return section;
  });

  return { bars: template.bars, sections };
}

export interface Skeleton {
  seed: string;
  root: RootName;
  mode: ModeName;
  bpm: number;
  progression: Progression;
  bars: number;
  sections: Section[];
}

/**
 * Key, mode and chord loop come from the seed so the same repo always sounds the same and
 * different repos sound distinct. Tempo is the one parameter a feature drives, because
 * size is the one thing a listener can plausibly hear.
 *
 * The order of the draws below is part of the output contract. Inserting one shifts the
 * key of every repo.
 */
export function buildSkeleton(features: RepoFeatures): Skeleton {
  const rng = createRng(features.seed, SKELETON_STREAM);
  const root = pick(ROOT_NAMES, rng() * ROOT_NAMES.length);
  const mode = pick(MODE_NAMES, rng() * MODE_NAMES.length);
  const progression = pickProgression(mode, rng);

  const bpm = tempoFor(features.totals.linesOfCode);
  const { bars, sections } = structureFor(bpm);

  return { seed: features.seed, root, mode, bpm, progression, bars, sections };
}

/** The four bars of chords the pad plays, in the skeleton's own key. */
export function chordLoop(skeleton: Skeleton, options?: RealizeOptions): RealizedChord[] {
  return realizeProgression(skeleton.progression, skeleton.mode, skeleton.root, options);
}

/** Assemble a Score. Events are sorted here so callers cannot emit an unordered one. */
export function scoreFrom(
  skeleton: Skeleton,
  events: readonly NoteEvent[] = [],
  timbre: Partial<Record<VoiceId, VoiceTimbre>> = {},
): Score {
  return {
    seed: skeleton.seed,
    bpm: skeleton.bpm,
    root: skeleton.root,
    mode: skeleton.mode,
    progressionId: skeleton.progression.id,
    bars: skeleton.bars,
    sections: skeleton.sections,
    events: sortEvents(events),
    timbre,
  };
}
