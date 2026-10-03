import { describe, expect, it } from 'vitest';
import { TICKS_PER_BAR, TICKS_PER_BEAT } from '../music/score';
import { ticksAtSeconds } from './clock';

describe('ticksAtSeconds', () => {
  it('converts at the tempo it is given', () => {
    // 120 BPM: a beat every half second, four sixteenths to the beat.
    expect(ticksAtSeconds(0, 120, 640)).toBe(0);
    expect(ticksAtSeconds(0.5, 120, 640)).toBe(TICKS_PER_BEAT);
    expect(ticksAtSeconds(2, 120, 640)).toBe(TICKS_PER_BAR);

    // Half the tempo, half the distance in the same time.
    expect(ticksAtSeconds(2, 60, 640)).toBe(TICKS_PER_BAR / 2);
  });

  it('is fractional between sixteenths', () => {
    // A visual that can only land on a sixteenth moves in sixteen steps a bar however smooth
    // the framerate is, and reads as a slideshow rather than as motion.
    expect(ticksAtSeconds(0.125, 120, 640)).toBeCloseTo(1, 6);
    expect(ticksAtSeconds(0.0625, 120, 640)).toBeCloseTo(0.5, 6);
  });

  it('wraps into the loop instead of running off the end', () => {
    const total = 64;
    // 8 seconds at 120 BPM is 64 ticks — exactly one lap, so back to the start.
    expect(ticksAtSeconds(8, 120, total)).toBe(0);
    expect(ticksAtSeconds(9, 120, total)).toBe(8);
    expect(ticksAtSeconds(25, 120, total)).toBe(8);
  });

  it('never returns a negative position', () => {
    // A transport reports one in the instant between being started and the context reaching
    // it, and a negative index into anything downstream is a blank frame at best.
    expect(ticksAtSeconds(-0.5, 120, 64)).toBeGreaterThanOrEqual(0);
    expect(ticksAtSeconds(-100, 120, 64)).toBeGreaterThanOrEqual(0);
  });

  it('answers 0 rather than NaN for nonsense', () => {
    // NaN reaching a canvas is an invisible element, which is the hardest kind of drawing
    // bug to trace back — the same reason music/palette.ts clamps rather than returning
    // undefined.
    for (const value of [
      ticksAtSeconds(Number.NaN, 120, 64),
      ticksAtSeconds(1, 0, 64),
      ticksAtSeconds(1, 120, 0),
      ticksAtSeconds(Infinity, 120, 64),
    ]) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBe(0);
    }
  });
});
