import { createRng } from '../music/rng';

/**
 * The colours a repository is drawn in.
 *
 * Built the way the music is built, and deliberately so: a fixed harmonic structure with the
 * seed choosing where in it to sit. The music does not let a feature pick a pitch, it lets
 * the seed pick a key and confines every voice to that scale; this does not let the seed pick
 * six colours, it lets the seed pick one hue and derives the rest by fixed rotations from it.
 * Six free hues would clash on some seeds and there would be no way to know which.
 *
 * ## Why OKLCH and not HSL
 *
 * The hue is arbitrary — it comes from a commit — so every hue has to work. In HSL that is
 * not true: yellow at 50% lightness is roughly twice as bright as blue at 50% lightness, so a
 * palette that reads evenly on one repository would have one column glaring and another
 * vanishing on the next. OKLCH is perceptually uniform, which is exactly the property needed
 * when you cannot see the input in advance. The conversion below is the price of that.
 */

/**
 * Rotations from the base hue, in degrees, by module rank.
 *
 * Analogous, widening with rank, and one near-complement at the end. Rank is prominence in
 * both media — the largest module is the loudest voice and the widest column — so the base
 * hue goes to rank 1 and the colour that disagrees most with it goes to the smallest module,
 * where it is a spark rather than a fight.
 */
const ROTATIONS = [0, 30, -30, 62, -62, 150] as const;

/** Lightness and chroma by rank: prominence falls with rank, as the voice gain does. */
const LIGHTNESS = [0.82, 0.78, 0.74, 0.7, 0.67, 0.64] as const;
const CHROMA = [0.16, 0.15, 0.14, 0.12, 0.11, 0.1] as const;

export interface Palette {
  /** The ground. Tinted by the same hue, so a repository's clip is recognisable unplayed. */
  readonly ground: string;
  /** Hairlines and inactive marks. */
  readonly quiet: string;
  /** One per module rank, longest first. Always six, whatever the repository has. */
  readonly modules: readonly string[];
}

/**
 * Its own rng stream, like the kit's.
 *
 * The order of draws inside a stream is part of the output contract, so a colour drawn from
 * the skeleton's stream would have changed the key of every repository ever rendered.
 */
const PALETTE_STREAM = 'palette';

export function paletteFor(seed: string): Palette {
  return paletteAt(hueFor(seed));
}

/** The hue a seed asks for, before anything else has laid claim to it. */
function hueFor(seed: string): number {
  return createRng(seed, PALETTE_STREAM)() * 360;
}

/**
 * Palettes for a set of repositories seen together, spread so none of them collides.
 *
 * Each seed still derives its own hue; a repository shown alone gets exactly what
 * `paletteFor` gives it. Within a set, that hue becomes a preference rather than a claim.
 *
 * The reason is that independent draws from a circle do not spread out — they clump, the way
 * eight coin flips are rarely four and four — and a gallery whose entire point is that every
 * repository looks like itself read as about five colour families instead of eight.
 *
 * The wheel is anchored on the first seed's true hue and divided into as many slots as there
 * are repositories, so the set is spread as widely as it can be: eight tiles land 45 degrees
 * apart. Each later seed takes the slot nearest the hue it wanted, or the next free one going
 * round. Anchoring rather than using a fixed grid keeps a set's colours its own, and means the
 * first repository is never moved at all.
 *
 * Slots rather than nudging a hue past whatever is blocking it, which was the first attempt
 * and was wrong: pushing past the nearest occupant can drop a third seed exactly where the
 * second already sits, and it terminates only by luck. A fixed number of slots and a linear
 * probe cannot fail to place everyone, which is what matters when the alternative is two
 * tiles the same colour.
 */
export function palettesFor(seeds: readonly string[]): Palette[] {
  if (seeds.length === 0) return [];

  const step = 360 / seeds.length;
  const anchor = hueFor(seeds[0] ?? '');
  const taken = new Set<number>();

  return seeds.map((seed) => {
    const offset = ((((hueFor(seed) - anchor) % 360) + 360) % 360) / step;

    let slot = Math.round(offset) % seeds.length;
    for (let probe = 0; probe < seeds.length && taken.has(slot); probe++) {
      slot = (slot + 1) % seeds.length;
    }

    taken.add(slot);
    return paletteAt(anchor + slot * step);
  });
}

function paletteAt(hue: number): Palette {
  return {
    // Not black, and not a trace of hue either.
    //
    // This was 0.022 chroma, which is technically a tint and perceptually nothing: with the
    // colour confined to the marks and the read line, three repositories with quite
    // different hues all read as "near-black with a neon line", and the palette was doing
    // its work in the one part of the image nobody looks at. The ground is the largest
    // surface there is, so it is where a repository's colour has to live if it is going to
    // be visible at the size a clip is watched.
    ground: oklch(0.19, 0.05, hue + 210),
    quiet: oklch(0.4, 0.035, hue + 210),
    modules: ROTATIONS.map((rotation, rank) =>
      oklch(LIGHTNESS[rank] ?? 0.64, CHROMA[rank] ?? 0.1, hue + rotation),
    ),
  };
}

/**
 * OKLCH to an sRGB hex string, with the hue preserved.
 *
 * Written out rather than passed to the browser as an `oklch()` string, because this is drawn
 * to a canvas: `fillStyle` takes a CSS colour, support for the newer spaces varies by engine,
 * and a `fillStyle` the browser cannot parse is silently ignored — leaving the previous colour
 * in place. A palette that fails by drawing everything in one colour is worse than one that
 * costs thirty lines of arithmetic.
 *
 * ## Why the chroma search
 *
 * Not every OKLCH colour exists in sRGB, and the usual response — clamp each channel into
 * range — quietly changes the hue, because the three channels are clipped by different
 * amounts. That is not a rounding error. Eight gallery hues laid out exactly 45 degrees apart
 * came back 28 degrees apart once rendered, which is most of the separation the layout had
 * just been careful to create, and it defeats the entire reason for working in a perceptually
 * uniform space.
 *
 * So an out-of-gamut colour loses saturation instead of hue: chroma is reduced until the
 * colour fits. A slightly paler blue is still that blue; a clipped one is a different colour.
 */
export function oklch(lightness: number, chroma: number, hueDegrees: number): string {
  const hue = (hueDegrees * Math.PI) / 180;

  // Binary search for the most chroma this hue can carry at this lightness. Twelve steps
  // resolves it far below anything an eye or an 8-bit channel can distinguish.
  let low = 0;
  let high = chroma;
  if (!fits(linearRgb(lightness, chroma, hue))) {
    for (let step = 0; step < 12; step++) {
      const mid = (low + high) / 2;
      if (fits(linearRgb(lightness, mid, hue))) low = mid;
      else high = mid;
    }
  } else {
    low = chroma;
  }

  return '#' + linearRgb(lightness, low, hue).map(channel).join('');
}

/** OKLCH to linear sRGB, before any gamut decision has been made. */
function linearRgb(lightness: number, chroma: number, hue: number): [number, number, number] {
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);

  // OKLab to cone response, then cubed: the non-linearity that makes the space uniform.
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;

  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function fits(rgb: readonly number[]): boolean {
  // A hair of tolerance, so a colour sitting exactly on the boundary is not searched away
  // from by floating point alone.
  return rgb.every((value) => value >= -0.0001 && value <= 1.0001);
}

/** Linear light to a two-digit sRGB hex component. */
function channel(value: number): string {
  const encoded =
    value <= 0.0031308 ? 12.92 * value : 1.055 * Math.abs(value) ** (1 / 2.4) - 0.055;
  const byte = Math.round(Math.min(Math.max(encoded, 0), 1) * 255);
  return byte.toString(16).padStart(2, '0');
}
