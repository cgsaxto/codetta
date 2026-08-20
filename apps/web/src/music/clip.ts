import { barToTick, scoreDurationSeconds, tickToSeconds, type Score } from './score';

/**
 * Which thirty seconds of a piece are worth sending to someone.
 *
 * docs/roadmap.md is specific: the clip starts at the peak, not at the intro. The intro is
 * pad and bass alone for four bars — by design, because a piece needs somewhere to arrive
 * from — and a clip that opens with it spends its first eight seconds on the least
 * characteristic part of the repository. The peak is where every voice is playing, which is
 * the only section that sounds like the thing the gallery is advertising.
 *
 * Pure, and separate from anything that renders, because the same answer has to serve the
 * audio file and the video: two artifacts of the same moment, or the pairing is a lie.
 */

/** How long a shareable clip runs. Long enough to be a piece of music, short enough to post. */
export const CLIP_SECONDS = 30;

export interface Window {
  startSeconds: number;
  durationSeconds: number;
}

/**
 * The clip window for a score, clamped to what the piece can actually supply.
 *
 * The clamp is not defensive padding. Every template puts the peak comfortably more than
 * thirty seconds from the end — the tightest is the 24-bar template at 84 BPM, which still
 * leaves 45 seconds — so the clamp never fires today, and clip.test.ts asserts that across
 * all fifteen tempos. It exists so that a future template that breaks the assumption
 * produces a short clip rather than one that runs off the end into silence.
 */
export function clipWindow(score: Score, seconds = CLIP_SECONDS): Window {
  const peak = score.sections.find((section) => section.name === 'peak');
  const total = scoreDurationSeconds(score);

  const startSeconds = peak ? tickToSeconds(barToTick(peak.startBar), score.bpm) : 0;
  const available = Math.max(0, total - startSeconds);

  return { startSeconds, durationSeconds: Math.min(seconds, available) };
}
