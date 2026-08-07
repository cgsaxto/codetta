import { MODES, ROOT_PITCH_CLASS, type ModeName, type RootName } from './progressions';

/**
 * The Score is the only thing music/ produces and the only thing audio/ consumes.
 *
 * It is plain data on purpose. Time is measured in 16th-note ticks rather than seconds,
 * so the grid rule from docs/music-mapping.md — "nothing shorter, nothing off-grid" —
 * is unrepresentable to break rather than merely discouraged. Being plain data also
 * means a Score can be serialised and diffed, which is what makes the fixture regression
 * check in CLAUDE.md a JSON comparison instead of a WAV comparison.
 */

export const BEATS_PER_BAR = 4;
export const TICKS_PER_BEAT = 4;
export const TICKS_PER_BAR = BEATS_PER_BAR * TICKS_PER_BEAT;

/** docs/music-mapping.md, Layer 2. More than this is a wall of sound. */
export const MAX_CONCURRENT_NOTES = 8;

/** docs/music-mapping.md, Layer 1. Fast is not the same as exciting. */
export const MAX_BPM = 128;

/** docs/music-mapping.md, Layer 1. Guaranteed by the Layer 4 templates. */
export const MIN_DURATION_SECONDS = 60;
export const MAX_DURATION_SECONDS = 90;

/** Rank order from the Layer 2 table. Also the tie-break for canonical event ordering. */
export const VOICE_ORDER = [
  'pad',
  'bass',
  'lead',
  'arp',
  'bell',
  'texture',
  'kick',
  'hat',
] as const;

export type VoiceId = (typeof VOICE_ORDER)[number];

export const PERCUSSION_VOICES = ['kick', 'hat'] as const;
export type PercussionVoiceId = (typeof PERCUSSION_VOICES)[number];
export type MelodicVoiceId = Exclude<VoiceId, PercussionVoiceId>;

/**
 * Percussion has no pitch, but sharing one event type keeps the audio layer simple.
 * Fixing the note number means a melody on the kick cannot be expressed by accident.
 */
export const PERCUSSION_MIDI: Record<PercussionVoiceId, number> = {
  kick: 36,
  hat: 42,
};

/** Inclusive MIDI bounds, straight from the register column of the Layer 2 table. */
export const VOICE_REGISTERS: Record<MelodicVoiceId, readonly [number, number]> = {
  pad: [48, 72], // C3–C5
  bass: [24, 36], // C1–C2
  lead: [60, 84], // C4–C6
  arp: [60, 72], // C4–C5
  bell: [72, 84], // C5–C6
  texture: [48, 60], // C3–C4
};

export const SECTION_ORDER = ['intro', 'build', 'peak', 'break', 'return', 'outro'] as const;

export type SectionName = (typeof SECTION_ORDER)[number];

export interface Section {
  name: SectionName;
  /** 0-indexed bar the section starts on. */
  startBar: number;
  bars: number;
}

export interface NoteEvent {
  voice: VoiceId;
  /** 16th-note grid position from the start of the piece. Always a non-negative integer. */
  tick: number;
  /** Length in 16th-note ticks. Always at least 1. */
  durationTicks: number;
  midi: number;
  /** 0 exclusive to 1 inclusive. */
  velocity: number;
}

/**
 * Timbral choices, per voice.
 *
 * Normalised 0–1, never hertz and never milliseconds. A filter cutoff is a frequency, and
 * CLAUDE.md forbids a repo feature from choosing one — so music/ says how open a voice
 * should be and audio/ owns the palette that turns into an actual cutoff. Exactly the same
 * split as pitch: a scale degree here, a frequency there.
 */
export interface VoiceTimbre {
  /** 0 is closed and dry, 1 is open and airy. */
  openness: number;
}

export interface Score {
  /** `RepoFeatures.seed`, carried through so a rendered Score is self-identifying. */
  seed: string;
  bpm: number;
  root: RootName;
  mode: ModeName;
  progressionId: string;
  bars: number;
  sections: Section[];
  events: NoteEvent[];
  /** Only the voices that have a timbral choice to make appear here. */
  timbre: Partial<Record<VoiceId, VoiceTimbre>>;
}

export function barToTick(bar: number): number {
  return bar * TICKS_PER_BAR;
}

export function tickToSeconds(tick: number, bpm: number): number {
  return (tick * 60) / (bpm * TICKS_PER_BEAT);
}

export function scoreDurationSeconds(score: Score): number {
  return tickToSeconds(barToTick(score.bars), score.bpm);
}

function voiceRank(voice: VoiceId): number {
  return VOICE_ORDER.indexOf(voice);
}

function isPercussion(voice: VoiceId): voice is PercussionVoiceId {
  return (PERCUSSION_VOICES as readonly VoiceId[]).includes(voice);
}

/**
 * Canonical ordering. Two Scores that sound identical must serialise identically, or the
 * fixture diff reports noise instead of changes.
 */
export function compareEvents(a: NoteEvent, b: NoteEvent): number {
  return (
    a.tick - b.tick ||
    voiceRank(a.voice) - voiceRank(b.voice) ||
    a.midi - b.midi ||
    a.durationTicks - b.durationTicks
  );
}

export function sortEvents(events: readonly NoteEvent[]): NoteEvent[] {
  return [...events].sort(compareEvents);
}

function scalePitchClasses(root: RootName, mode: ModeName): Set<number> {
  const tonic = ROOT_PITCH_CLASS[root];
  return new Set(MODES[mode].map((offset) => (tonic + offset) % 12));
}

export interface ScoreProblem {
  kind: string;
  detail: string;
}

/**
 * Every check here is one line from the anti-patterns list in docs/music-mapping.md.
 * Returns problems rather than throwing so tests can assert on specific violations.
 */
export function validateScore(score: Score): ScoreProblem[] {
  const problems: ScoreProblem[] = [];
  const report = (kind: string, detail: string) => problems.push({ kind, detail });

  if (!Number.isInteger(score.bars) || score.bars <= 0) {
    report('bars', `bars must be a positive integer, got ${score.bars}`);
  }
  if (!(score.bpm > 0)) {
    report('tempo', `bpm must be positive, got ${score.bpm}`);
  } else if (score.bpm > MAX_BPM) {
    report('tempo', `bpm ${score.bpm} exceeds the ${MAX_BPM} ceiling`);
  }

  const duration = scoreDurationSeconds(score);
  if (duration < MIN_DURATION_SECONDS || duration > MAX_DURATION_SECONDS) {
    report(
      'duration',
      `${duration.toFixed(1)} s is outside ${MIN_DURATION_SECONDS}–${MAX_DURATION_SECONDS} s`,
    );
  }

  for (const [voice, timbre] of Object.entries(score.timbre)) {
    if (timbre && !(timbre.openness >= 0 && timbre.openness <= 1)) {
      report('timbre', `${voice} openness must be in 0–1, got ${timbre.openness}`);
    }
  }

  validateSections(score, report);
  validateEvents(score, report);
  validateConcurrency(score, report);

  return problems;
}

type Report = (kind: string, detail: string) => void;

function validateSections(score: Score, report: Report): void {
  const names = score.sections.map((section) => section.name);
  if (names.join() !== SECTION_ORDER.join()) {
    report(
      'sections',
      `expected ${SECTION_ORDER.join(' → ')}, got ${names.join(' → ') || '(none)'}`,
    );
  }

  let expectedStart = 0;
  for (const section of score.sections) {
    if (section.startBar !== expectedStart) {
      report(
        'sections',
        `${section.name} starts at bar ${section.startBar}, expected ${expectedStart}`,
      );
    }
    // The chord loop is 4 bars, so this is what makes every section begin on the tonic.
    if (section.bars <= 0 || section.bars % 4 !== 0) {
      report('sections', `${section.name} is ${section.bars} bars, must be a multiple of 4`);
    }
    expectedStart = section.startBar + section.bars;
  }

  if (score.sections.length > 0 && expectedStart !== score.bars) {
    report('sections', `sections cover ${expectedStart} bars, score declares ${score.bars}`);
  }
}

function validateEvents(score: Score, report: Report): void {
  const totalTicks = barToTick(score.bars);
  const inScale = scalePitchClasses(score.root, score.mode);

  for (const [index, event] of score.events.entries()) {
    const where = `event ${index} (${event.voice} @ tick ${event.tick})`;

    if (!Number.isInteger(event.tick) || event.tick < 0) {
      report('grid', `${where}: tick must be a non-negative integer`);
    }
    if (!Number.isInteger(event.durationTicks) || event.durationTicks < 1) {
      report(
        'grid',
        `${where}: duration must be at least one 16th, got ${event.durationTicks}`,
      );
    }
    if (event.tick + event.durationTicks > totalTicks) {
      report('grid', `${where}: runs past the end of the piece at tick ${totalTicks}`);
    }
    if (!(event.velocity > 0) || event.velocity > 1) {
      report('velocity', `${where}: velocity must be in (0, 1], got ${event.velocity}`);
    }
    if (!Number.isInteger(event.midi)) {
      report('pitch', `${where}: midi must be an integer, got ${event.midi}`);
    }

    if (isPercussion(event.voice)) {
      const expected = PERCUSSION_MIDI[event.voice];
      if (event.midi !== expected) {
        report(
          'pitch',
          `${where}: ${event.voice} must use midi ${expected}, got ${event.midi}`,
        );
      }
      continue;
    }

    if (!inScale.has(((event.midi % 12) + 12) % 12)) {
      report('pitch', `${where}: midi ${event.midi} is outside ${score.root} ${score.mode}`);
    }

    const register = VOICE_REGISTERS[event.voice];
    if (event.midi < register[0] || event.midi > register[1]) {
      report(
        'register',
        `${where}: midi ${event.midi} is outside ${event.voice} range ${register[0]}–${register[1]}`,
      );
    }
  }

  const sorted = sortEvents(score.events);
  const isSorted = score.events.every((event, i) => event === sorted[i]);
  if (!isSorted) {
    report('ordering', 'events are not in canonical order — run sortEvents before emitting');
  }
}

function validateConcurrency(score: Score, report: Report): void {
  const totalTicks = barToTick(score.bars);
  if (totalTicks <= 0) return;

  // Delta encoding, then a prefix sum, so this stays linear in ticks plus events.
  const deltas = new Array<number>(totalTicks + 1).fill(0);
  for (const event of score.events) {
    const start = event.tick;
    const end = event.tick + event.durationTicks;
    if (!Number.isInteger(start) || start < 0 || start >= totalTicks) continue;
    deltas[start] = (deltas[start] ?? 0) + 1;
    const clampedEnd = Math.min(Math.max(end, start + 1), totalTicks);
    deltas[clampedEnd] = (deltas[clampedEnd] ?? 0) - 1;
  }

  let active = 0;
  let worstTick = -1;
  let worst = 0;
  for (let tick = 0; tick < totalTicks; tick++) {
    active += deltas[tick] ?? 0;
    if (active > worst) {
      worst = active;
      worstTick = tick;
    }
  }

  if (worst > MAX_CONCURRENT_NOTES) {
    report(
      'polyphony',
      `${worst} notes sound together at tick ${worstTick}, ceiling is ${MAX_CONCURRENT_NOTES}`,
    );
  }
}

export function assertValidScore(score: Score): void {
  const problems = validateScore(score);
  if (problems.length === 0) return;
  const lines = problems.map((problem) => `  [${problem.kind}] ${problem.detail}`);
  throw new Error(`Score has ${problems.length} problem(s):\n${lines.join('\n')}`);
}
