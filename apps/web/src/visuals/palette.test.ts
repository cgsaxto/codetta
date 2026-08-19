import { describe, expect, it } from 'vitest';
import { oklch, paletteFor, palettesFor } from './palette';

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

describe('palettesFor', () => {
  /** OKLab coordinates recovered from a rendered colour, by inverting what palette.ts did. */
  function oklab(hex: string): [number, number, number] {
    const [r, g, b] = [1, 3, 5].map((at) => {
      const value = parseInt(hex.slice(at, at + 2), 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];

    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

    return [
      0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    ];
  }

  /**
   * Perceived difference between two rendered colours.
   *
   * Distance in OKLab rather than an angle between hues, which is what this measured first
   * and got wrong twice over. A hue angle says nothing about how far apart two colours look
   * once one of them has been desaturated to fit in sRGB, and it is numerically unstable at
   * low chroma — it reported a correct 45-degree layout as 28 degrees and failed a passing
   * implementation. Distance is the quantity the claim is actually about: whether a person
   * can tell two tiles apart.
   */
  function apartInLab(a: string, b: string): number {
    const [al, aa, ab] = oklab(a);
    const [bl, ba, bb] = oklab(b);
    return Math.hypot(al - bl, aa - ba, ab - bb);
  }

  const gallery = [
    '20425723',
    '1f6589ec',
    '8b258c7b',
    'cbd7a410',
    '13073f1e',
    '0ed457cf',
    'a3714473',
    'deadbeef',
  ];

  it('pulls a set apart that would otherwise clump', () => {
    // Independent draws from a circle do not spread out. Two of the real gallery seeds landed
    // on neighbouring hues, and the page read as about five colour families rather than
    // eight. A just-noticeable difference in OKLab is around 0.02; this asks for several
    // times that, because the claim is that a tile is recognisable at a glance rather than
    // distinguishable side by side.
    const colours = palettesFor(gallery).map((palette) => palette.modules[0] ?? '');

    for (let i = 0; i < colours.length; i++) {
      for (let j = i + 1; j < colours.length; j++) {
        expect(
          apartInLab(colours[i] ?? '', colours[j] ?? ''),
          `${i} vs ${j}: ${colours[i]} and ${colours[j]}`,
        ).toBeGreaterThan(0.06);
      }
    }
  });

  it('gives each repository its own ground, which is most of the tile', () => {
    const grounds = palettesFor(gallery).map((palette) => palette.ground);
    expect(new Set(grounds).size).toBe(gallery.length);
  });

  it('leaves the first of a set exactly where it asked to be', () => {
    // Nothing has claimed anything yet, so the preference is honoured outright. Only a later
    // one ever moves — the same rule, and the same reason, as resolving a unison.
    expect(palettesFor(gallery)[0]).toStrictEqual(paletteFor(gallery[0] ?? ''));
    for (const seed of gallery) {
      expect(palettesFor([seed])[0]).toStrictEqual(paletteFor(seed));
    }
  });

  it('is stable for a set, in the order it is given', () => {
    expect(palettesFor(gallery)).toStrictEqual(palettesFor(gallery));
  });

  it('places every seed, at any size, without giving up', () => {
    // Convergence is the property worth pinning. The first attempt nudged a hue past whatever
    // blocked it, which can drop a third seed exactly where the second already sits and only
    // terminates by luck; a fixed number of slots and a linear probe cannot fail.
    for (const size of [1, 2, 8, 12, 20]) {
      const seeds = Array.from({ length: size }, (_, n) =>
        (n * 2654435761).toString(16).padStart(8, '0').slice(-8),
      );
      const palettes = palettesFor(seeds);
      expect(palettes).toHaveLength(size);
      expect(new Set(palettes.map((p) => p.ground)).size, `${size} seeds`).toBe(size);
    }
  });

  it('returns nothing for nothing', () => {
    expect(palettesFor([])).toStrictEqual([]);
  });
});
