/**
 * Seeded PRNG. The promise in CLAUDE.md — the same commit SHA produces the same audio,
 * forever — rests entirely on this file.
 *
 * ## Why named streams instead of one generator
 *
 * A single shared sequence couples every consumer to every other consumer's draw order.
 * Add one extra draw while tuning the lead, and the arp, the bell, the key and the tempo
 * of every repo ever rendered shift too — silently, with no failing test, and with no way
 * to tell a deliberate musical change from an accidental one. Naming a stream buys the
 * ability to change one voice without rewriting the past.
 *
 * Streams are independent: drawing from one never advances another.
 *
 * ## Streams vs. hashes
 *
 * `createRng` is for choices made once in a fixed order — the key, the progression, a
 * voice's density. `unitHash` is for choices derived from a specific thing, like a file's
 * pitch, where the answer must stay put even if the number of draws around it changes.
 * Reach for `unitHash` whenever a value has a natural identity to hash.
 */

/** Always returns a float in [0, 1). Structurally compatible with `Math.random`. */
export type Rng = () => number;

/**
 * xmur3 — a string hash with good avalanche. Used to expand a short seed into the four
 * 32-bit words sfc32 needs, and to back `hashString`.
 */
function xmur3(text: string): () => number {
  let h = 1779033703 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

/** sfc32 — 128 bits of state, fast, and passes PractRand. Overkill here, which is fine. */
function sfc32(seedA: number, seedB: number, seedC: number, seedD: number): Rng {
  let a = seedA | 0;
  let b = seedB | 0;
  let c = seedC | 0;
  let d = seedD | 0;

  return () => {
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

/**
 * Length-prefixed so that the seed/stream boundary is unambiguous. Without it
 * `("a:b", "c")` and `("a", "b:c")` would hash to the same generator, which would make
 * two unrelated streams silently identical.
 */
function streamKey(seed: string, stream: string): string {
  return `${seed.length}:${seed}:${stream}`;
}

/** sfc32's first outputs are correlated across similar states. Standard advice is ~12. */
const WARMUP_DRAWS = 12;

/**
 * Build the generator for one named stream of one seed.
 *
 * `seed` is `RepoFeatures.seed`. `stream` names what the numbers are for — 'skeleton',
 * 'voice:lead', and so on. Renaming a stream changes that stream's output for every repo,
 * so treat stream names as part of the output contract, not as comments.
 */
export function createRng(seed: string, stream: string): Rng {
  const expand = xmur3(streamKey(seed, stream));
  const next = sfc32(expand(), expand(), expand(), expand());
  for (let i = 0; i < WARMUP_DRAWS; i++) next();
  return next;
}

/** Stable 32-bit hash of a string. Same input, same output, across runs and machines. */
export function hashString(text: string): number {
  return xmur3(text)();
}

/**
 * A value in [0, 1) derived from a string, consuming no stream state.
 *
 * Use this for anything with an identity — a file path, a module path — so that its
 * musical choice survives unrelated edits elsewhere in the generation path.
 */
export function unitHash(text: string): number {
  return hashString(text) / 4294967296;
}
