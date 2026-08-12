import { describe, expect, it } from 'vitest';
import { oklch, paletteFor } from './palette';

/** sRGB hex → relative luminance, the quantity WCAG contrast is built on. */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((at) => {
    const value = parseInt(hex.slice(at, at + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return (
    0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0)
  );
}

function contrast(a: string, b: string): number {
  const [dark, light] = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

/** Perceived difference between two colours, roughly, in OKLab terms via sRGB distance. */
function apart(a: string, b: string): number {
  return Math.hypot(
    ...[1, 3, 5].map(
      (at) => parseInt(a.slice(at, at + 2), 16) - parseInt(b.slice(at, at + 2), 16),
    ),
  );
}

describe('oklch', () => {
  it('produces a parseable hex colour', () => {
    // The reason this arithmetic is here at all: a fillStyle the browser cannot parse is
    // silently ignored and the previous colour stays, so a palette can fail by drawing
    // everything in one colour rather than by throwing.
    for (const hue of [0, 90, 180, 270, 359]) {
      expect(oklch(0.7, 0.14, hue), `hue ${hue}`).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('clamps colours that fall outside sRGB rather than wrapping them', () => {
    // High chroma at some hues is not representable. Wrapping would turn a too-saturated
    // green into a random colour; clamping only makes it less saturated.
    for (const hue of [0, 60, 120, 180, 240, 300]) {
      expect(oklch(0.9, 0.4, hue), `hue ${hue}`).toMatch(/^#[0-9a-f]{6}$/);
      expect(oklch(0.1, 0.4, hue), `hue ${hue}`).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('keeps lightness even across hues, which is the whole reason for the space', () => {
    // The property HSL does not have. A palette whose hue comes from a commit has to work at
    // every hue, and in HSL yellow at 50% is about twice the brightness of blue at 50% — one
    // column would glare and another would vanish depending on the repository.
    const luminances = [0, 60, 120, 180, 240, 300].map((hue) =>
      luminance(oklch(0.75, 0.13, hue)),
    );
    const spread = Math.max(...luminances) / Math.min(...luminances);
    expect(spread).toBeLessThan(1.8);
  });
});

describe('paletteFor', () => {
  const seeds = ['20425723', '1f6589ec', 'deadbeef', '00000000', 'ffffffff', 'a3714473'];

  it('is stable for a seed, which is the promise the whole project makes', () => {
    for (const seed of seeds) {
      expect(paletteFor(seed)).toStrictEqual(paletteFor(seed));
    }
  });

  it('gives different repositories different colours', () => {
    const grounds = new Set(seeds.map((seed) => paletteFor(seed).ground));
    expect(grounds.size).toBe(seeds.length);
  });

  it('always offers six module colours, whatever the repository holds', () => {
    // A repository with two modules still indexes into this by rank, and an undefined
    // fillStyle leaves the previous colour in place rather than failing.
    for (const seed of seeds) {
      expect(paletteFor(seed).modules).toHaveLength(6);
      for (const colour of paletteFor(seed).modules) expect(colour).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('keeps every module legible against its own ground', () => {
    // The marks carry the meaning; a column that disappears on some seeds is the palette
    // failing silently on exactly the repositories nobody tested.
    for (const seed of seeds) {
      const { ground, modules } = paletteFor(seed);
      for (const [rank, colour] of modules.entries()) {
        expect(contrast(ground, colour), `${seed} rank ${rank}`).toBeGreaterThan(4.5);
      }
    }
  });

  it('keeps the modules apart from each other', () => {
    // Six colours that are individually legible can still be indistinguishable in pairs, and
    // two columns the same colour is the same as having one fewer voice on screen.
    for (const seed of seeds) {
      const { modules } = paletteFor(seed);
      for (let i = 0; i < modules.length; i++) {
        for (let j = i + 1; j < modules.length; j++) {
          expect(
            apart(modules[i] ?? '', modules[j] ?? ''),
            `${seed}: ${i} vs ${j}`,
          ).toBeGreaterThan(24);
        }
      }
    }
  });

  it('holds those properties across the whole range of seeds, not the ones I picked', () => {
    // The hue comes from a commit sha, so "works on the seeds in the test" is not a claim
    // worth making. Two hundred synthetic seeds sweep the circle.
    for (let n = 0; n < 200; n++) {
      const seed = (n * 2654435761).toString(16).padStart(8, '0').slice(-8);
      const { ground, modules } = paletteFor(seed);
      for (const [rank, colour] of modules.entries()) {
        expect(contrast(ground, colour), `${seed} rank ${rank}`).toBeGreaterThan(4.5);
      }
    }
  });
});
