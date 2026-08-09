import type { RepoModule } from '@codetta/schema';

/**
 * Layer 3's calibration: raw RepoFeatures numbers in, a 0–1 position out.
 *
 * Every mapping in docs/music-mapping.md is "feature selects an index into a palette", and
 * this is the step in between. It exists as its own file because the alternative was what
 * used to be here — each voice clamping and scaling its own feature inline, with the same
 * two density constants copied into three files — which meant recalibrating was a change in
 * four places that had to agree.
 *
 * ## Why the numbers below are what they are
 *
 * The ranges the voices were originally tuned against came from `fixtures/react.json`, which
 * was hand-authored by eyeballing a repository rather than by parsing one. They were not
 * slightly off; they were off by an order of magnitude, and three of the five mappings
 * carried no information at all as a result. `cyclomaticDensity` was assumed to sit in
 * 0.17–0.34 and really sits in 0.001–0.025, so every repository on earth clamped to the same
 * density floor and got the same rhythm.
 *
 * The anchors here come from parsing eight repositories across all four supported languages
 * — react, vue, django, flask, requests, express, gin, cobra — which is 44 modules. Low and
 * high are the 10th and 90th percentiles of that sample, rounded to numbers a person can
 * read, because four decimal places from 44 samples is false precision.
 *
 * Percentiles rather than min and max deliberately. Anchoring on the extremes would leave
 * the middle of every palette unreachable for almost every repository; anchoring at p10/p90
 * means a fifth of modules clamp at an end, which is the intended cost of making the whole
 * palette usable.
 *
 * These are absolute, not normalised per repository. A relative scale would guarantee that
 * every repo's deepest module got the top octave, which sounds like the same piece with the
 * voices shuffled. Absolute anchors mean a repository that really is uniform sounds uniform,
 * and that is information rather than a defect.
 */

interface Anchors {
  readonly low: number;
  readonly high: number;
}

const ANCHORS = {
  nesting: { low: 0.05, high: 0.85 },
  functionLength: { low: 1.0, high: 7.0 },
  branching: { low: 0.001, high: 0.022 },
  comments: { low: 0.02, high: 0.28 },
  asynchrony: { low: 0.0, high: 0.15 },
} as const satisfies Record<string, Anchors>;

export function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), hi);
}

/**
 * Where a value sits between its anchors, 0–1. NaN and a degenerate range both land at the
 * bottom rather than propagating: a NaN reaching a palette index is silence or a click, and
 * that is the hardest class of audio bug to trace back to its cause.
 */
function position(value: number, anchors: Anchors): number {
  const span = anchors.high - anchors.low;
  if (!Number.isFinite(value) || span <= 0) return 0;
  return clamp((value - anchors.low) / span, 0, 1);
}

/** How deep the code nests, 0–1. Selects octave: deeper sits higher in the register. */
export function nestingPosition(module: RepoModule): number {
  return position(module.avgNestingDepth, ANCHORS.nesting);
}

/** How long the functions are, 0–1. Selects note duration: longer functions, longer notes. */
export function functionLengthPosition(module: RepoModule): number {
  return position(module.avgFunctionLength, ANCHORS.functionLength);
}

/**
 * How branchy the code is, 0–1. Selects note density.
 *
 * The spec calls this "probability a 16th slot fires", clamped to 0.15–0.75. Phase 0 found
 * that a memoryless per-slot coin flip produces rhythms that are irregular rather than
 * syncopated, so every voice replaced it with a curated rhythm palette ordered sparse to
 * busy — which this indexes. The clamp survives in the shape of the palettes themselves:
 * none of them is empty and none fires on every 16th.
 */
export function branchingPosition(module: RepoModule): number {
  return position(module.cyclomaticDensity, ANCHORS.branching);
}

/** How commented the code is, 0–1. Selects filter cutoff and reverb wet on the texture. */
export function commentPosition(module: RepoModule): number {
  return position(module.commentRatio, ANCHORS.comments);
}

/**
 * How asynchronous the code is, 0–1.
 *
 * Nothing reads this yet — the swing and delay it is meant to drive are the one row of the
 * Layer 3 table that was never built. It is here so the anchor lives with the others rather
 * than being invented separately later, and because the measurement is the awkward part: a
 * Go module's asyncRatio is 0 by definition and Python's median across this sample is also
 * 0, so more than half of all modules sit exactly on the low anchor. Whatever reads this has
 * to sound right when the answer is "no asynchrony at all", which is the common case.
 */
export function asynchronyPosition(module: RepoModule): number {
  return position(module.asyncRatio, ANCHORS.asynchrony);
}
