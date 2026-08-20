import { describe, expect, it } from 'vitest';
import { GALLERY } from '../features/gallery';
import { generateScore } from './generate';
import { CLIP_SECONDS, clipWindow } from './clip';
import { TEMPOS, buildSkeleton, scoreFrom } from './skeleton';
import { scoreDurationSeconds } from './score';
import { reactFeatures } from '../features/fixture';

describe('clipWindow', () => {
  it('starts at the peak, not at the intro', () => {
    // The intro is pad and bass alone for four bars, by design. A clip that opens with it
    // spends its first eight seconds on the least characteristic part of the repository.
    for (const entry of GALLERY) {
      const score = generateScore(entry);
      const peak = score.sections.find((section) => section.name === 'peak');
      const barSeconds = (60 / score.bpm) * 4;
      const expected = (peak?.startBar ?? 0) * barSeconds;

      expect(clipWindow(score).startSeconds, entry.repo.name).toBeCloseTo(expected, 6);
      expect(clipWindow(score).startSeconds, entry.repo.name).toBeGreaterThan(0);
    }
  });

  it('gives a full thirty seconds at every tempo the skeleton allows', () => {
    // The clamp in clipWindow exists for a template that does not exist yet. This is the
    // assertion that says so: across all fifteen tempos and all three structure templates,
    // the peak is far enough from the end that nothing is ever cut short.
    for (const bpm of TEMPOS) {
      const linesOfCode = 10 ** ((bpm - 72) / 56 + 3);
      const score = scoreFrom(
        buildSkeleton({ ...reactFeatures, totals: { ...reactFeatures.totals, linesOfCode } }),
      );
      const window = clipWindow(score);

      expect(window.durationSeconds, `${score.bpm} BPM`).toBe(CLIP_SECONDS);
      expect(
        window.startSeconds + window.durationSeconds,
        `${score.bpm} BPM`,
      ).toBeLessThanOrEqual(scoreDurationSeconds(score));
    }
  });

  it('shortens rather than running off the end', () => {
    // If a template ever put the peak inside the last thirty seconds, the honest answer is a
    // shorter clip. Rendering past the end would append silence to the thing being shared.
    const score = generateScore(GALLERY[0]!);
    const total = scoreDurationSeconds(score);
    const window = clipWindow(score, 10_000);

    expect(window.durationSeconds).toBe(total - window.startSeconds);
    expect(window.startSeconds + window.durationSeconds).toBeCloseTo(total, 6);
  });

  it('falls back to the start for a score with no peak', () => {
    const score = { ...generateScore(GALLERY[0]!), sections: [] };
    expect(clipWindow(score).startSeconds).toBe(0);
  });
});
