import { describe, expect, it } from 'vitest';
import { MIN_DETAIL, adjustDetail, smoothFps, stride } from './budget';

/** Run a machine of a given consistent frame time until the detail level settles. */
function settle(frameMs: number, from = 1): number {
  let detail = from;
  for (let frame = 0; frame < 500; frame++) detail = adjustDetail(detail, frameMs);
  return detail;
}

describe('adjustDetail', () => {
  it('leaves a machine that keeps up alone', () => {
    expect(settle(16)).toBe(1);
    expect(settle(8)).toBe(1);
  });

  it('sheds detail on a machine that does not', () => {
    // 33 ms is 30 fps. The picture gets simpler; the frames do not get slower.
    expect(settle(33)).toBe(MIN_DETAIL);
    expect(settle(50)).toBe(MIN_DETAIL);
  });

  it('never sheds everything', () => {
    // A degradation strategy that can blank the screen is worse than the slow frames it was
    // avoiding, and it would look exactly like a crash.
    for (const frameMs of [25, 40, 100, 1000]) {
      expect(settle(frameMs), `${frameMs}ms`).toBeGreaterThanOrEqual(MIN_DETAIL);
    }
  });

  it('sheds faster than it restores, so the picture settles instead of pulsing', () => {
    // Symmetric adjustment oscillates: detail drops, frames get cheap, detail returns,
    // frames get expensive, and the image pulses at a rate unrelated to the music.
    const shed = 1 - adjustDetail(1, 40);
    const restored = adjustDetail(0.5, 10) - 0.5;
    expect(shed).toBeGreaterThan(restored * 2);
  });

  it('does nothing in the band around 60 fps', () => {
    // Between the thresholds there is no adjustment at all, so a machine sitting near target
    // is not permanently nudging its own detail level up and down.
    expect(adjustDetail(0.6, 17)).toBe(0.6);
    expect(adjustDetail(0.6, 20)).toBe(0.6);
  });

  it('recovers when a machine stops being busy', () => {
    // A hitch from something else on the system should not cost the picture permanently.
    const dipped = settle(40);
    expect(settle(10, dipped)).toBe(1);
  });

  it('ignores a frame time that is not a measurement', () => {
    // The first frame after a tab is restored can be enormous or zero, and neither says
    // anything about how fast this machine draws.
    for (const bad of [0, -5, Number.NaN, Infinity]) {
      expect(adjustDetail(0.7, bad), `${bad}`).toBe(0.7);
    }
  });
});

describe('stride', () => {
  it('draws everything at full detail', () => {
    expect(stride(1)).toBe(1);
  });

  it('thins rather than truncates', () => {
    // Every nth, not the first n. Taking a prefix would empty the bottom of the field and
    // leave the top untouched — the same mistake the file cap made in apps/api.
    expect(stride(0.5)).toBe(2);
    expect(stride(MIN_DETAIL)).toBe(4);
  });

  it('never returns a stride that would draw nothing', () => {
    for (const detail of [0, -1, Number.NaN]) {
      expect(stride(detail), `${detail}`).toBeGreaterThanOrEqual(1);
      expect(Number.isFinite(stride(detail)), `${detail}`).toBe(true);
    }
  });
});

describe('smoothFps', () => {
  it('converges on the real rate', () => {
    let fps = 0;
    for (let frame = 0; frame < 200; frame++) fps = smoothFps(fps, 1000 / 60);
    expect(fps).toBeCloseTo(60, 1);
  });

  it('does not let one hitch dominate the reading', () => {
    // The number that matters is the one you can watch for a few seconds and believe.
    let steady = 0;
    for (let frame = 0; frame < 200; frame++) steady = smoothFps(steady, 1000 / 60);
    expect(smoothFps(steady, 40)).toBeGreaterThan(55);
  });

  it('holds its last reading through a frame time that is not a measurement', () => {
    expect(smoothFps(60, 0)).toBe(60);
    expect(smoothFps(60, Number.NaN)).toBe(60);
  });
});
