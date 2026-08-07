/**
 * Mirrors docs/features-schema.md. In Phase 1 this is replaced by the generated types in
 * `packages/schema`, which are the source of truth for both TypeScript and Go. Until the
 * API exists there is nothing to generate from, so it is hand-written here.
 *
 * Nothing music-related belongs in this file.
 */

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
  avgNestingDepth: number;
  maxNestingDepth: number;
  /** In statements, not lines. */
  avgFunctionLength: number;
  /** Branch nodes / total AST nodes, 0–1. */
  cyclomaticDensity: number;
  /** 0–1. */
  commentRatio: number;
  /** 0–1. */
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
