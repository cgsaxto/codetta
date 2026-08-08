/**
 * The RepoFeatures contract, as TypeScript sees it. `schema.go` is the same contract as Go
 * sees it, and `conformance.test.ts` plus `schema_test.go` are what keep the two honest.
 *
 * Nothing music-related belongs in this file. If a field name mentions pitch, tempo,
 * instrument or volume, it is in the wrong document — see docs/features-schema.md.
 */

export const SCHEMA_VERSION = 1;

export interface RepoIdentity {
  owner: string;
  name: string;
  ref: string;
  /** Full 40-char SHA. The cache key, and the source of `seed`. */
  commitSha: string;
  primaryLanguage: string;
  stars: number;
  fetchedAt: string;
}

export interface Totals {
  filesScanned: number;
  /** Over cap, binary, vendored, or an unsupported language. */
  filesSkipped: number;
  linesOfCode: number;
  functions: number;
  classes: number;
  imports: number;
}

export interface LanguageShare {
  name: string;
  /** 0–1. */
  share: number;
  files: number;
}

export interface RepoModule {
  path: string;
  /** Fraction of total LOC, 0–1. */
  share: number;
  files: number;
  linesOfCode: number;
  /** Mean max-depth per function. */
  avgNestingDepth: number;
  maxNestingDepth: number;
  /** In statements, not lines. */
  avgFunctionLength: number;
  /** Branch nodes / total AST nodes, 0–1. */
  cyclomaticDensity: number;
  /** Comment lines / total lines, 0–1. */
  commentRatio: number;
  /** Async or promise-returning fns / total fns, 0–1. */
  asyncRatio: number;
}

export interface TimelineEntry {
  index: number;
  modulePath: string;
  path: string;
  linesOfCode: number;
  functions: number;
  maxNesting: number;
  branches: number;
  commentLines: number;
}

export interface RepoFeatures {
  schemaVersion: number;
  repo: RepoIdentity;
  /** First 8 hex chars of `repo.commitSha`. Seeds every PRNG in the generation path. */
  seed: string;
  totals: Totals;
  languages: LanguageShare[];
  /** Top 6 directories by LOC, ordered by share descending. These become voices. */
  modules: RepoModule[];
  /** Depth-first, lexicographic by path. Capped at 256 entries. */
  timeline: TimelineEntry[];
}

/**
 * The field names of each type, as data.
 *
 * TypeScript types are erased at runtime, so without these a test cannot ask "does this
 * document carry a field TypeScript does not declare?" — and that is precisely the drift
 * that hand-writing two sides of a contract produces. `conformance.test.ts` proves at
 * compile time that each list is complete, then uses it to check the fixtures at runtime.
 */
export const REPO_IDENTITY_KEYS = [
  'owner',
  'name',
  'ref',
  'commitSha',
  'primaryLanguage',
  'stars',
  'fetchedAt',
] as const satisfies readonly (keyof RepoIdentity)[];

export const TOTALS_KEYS = [
  'filesScanned',
  'filesSkipped',
  'linesOfCode',
  'functions',
  'classes',
  'imports',
] as const satisfies readonly (keyof Totals)[];

export const LANGUAGE_SHARE_KEYS = [
  'name',
  'share',
  'files',
] as const satisfies readonly (keyof LanguageShare)[];

export const REPO_MODULE_KEYS = [
  'path',
  'share',
  'files',
  'linesOfCode',
  'avgNestingDepth',
  'maxNestingDepth',
  'avgFunctionLength',
  'cyclomaticDensity',
  'commentRatio',
  'asyncRatio',
] as const satisfies readonly (keyof RepoModule)[];

export const TIMELINE_ENTRY_KEYS = [
  'index',
  'modulePath',
  'path',
  'linesOfCode',
  'functions',
  'maxNesting',
  'branches',
  'commentLines',
] as const satisfies readonly (keyof TimelineEntry)[];

export const REPO_FEATURES_KEYS = [
  'schemaVersion',
  'repo',
  'seed',
  'totals',
  'languages',
  'modules',
  'timeline',
] as const satisfies readonly (keyof RepoFeatures)[];
