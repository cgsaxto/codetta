import { describe, expect, it } from 'vitest';
import { pick } from './palette';

const PALETTE = ['a', 'b', 'c'] as const;

describe('pick', () => {
  it('selects by index', () => {
    expect(pick(PALETTE, 0)).toBe('a');
    expect(pick(PALETTE, 2)).toBe('c');
  });

  it('truncates a fractional index rather than rounding', () => {
    expect(pick(PALETTE, 1.99)).toBe('b');
  });

  it('clamps out-of-range indices to the ends', () => {
    expect(pick(PALETTE, 3)).toBe('c');
    expect(pick(PALETTE, 99)).toBe('c');
    expect(pick(PALETTE, -1)).toBe('a');
    expect(pick(PALETTE, -Infinity)).toBe('a');
  });

  it('throws on NaN instead of yielding undefined', () => {
    // A NaN index downstream becomes a NaN pitch, which is silence, not a wrong note.
    expect(() => pick(PALETTE, NaN)).toThrow(/NaN/);
  });

  it('throws on an empty palette', () => {
    expect(() => pick([], 0)).toThrow(/palette of 0/);
  });
});
