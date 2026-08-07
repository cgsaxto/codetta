import { describe, expect, it } from 'vitest';
import { createRng, hashString, unitHash, type Rng } from './rng';
import { pickProgression } from './progressions';

const SEED = '7c8e5e7a';

function draw(rng: Rng, count: number): number[] {
  return Array.from({ length: count }, () => rng());
}

describe('createRng', () => {
  it('produces the same sequence for the same seed and stream', () => {
    expect(draw(createRng(SEED, 'skeleton'), 32)).toStrictEqual(
      draw(createRng(SEED, 'skeleton'), 32),
    );
  });

  it('produces a different sequence for a different seed', () => {
    const a = draw(createRng(SEED, 'skeleton'), 32);
    const b = draw(createRng('deadbeef', 'skeleton'), 32);
    expect(a).not.toStrictEqual(b);
    expect(a.filter((value, i) => value === b[i])).toHaveLength(0);
  });

  it('produces a different sequence for a different stream', () => {
    const lead = draw(createRng(SEED, 'voice:lead'), 32);
    const arp = draw(createRng(SEED, 'voice:arp'), 32);
    expect(lead.filter((value, i) => value === arp[i])).toHaveLength(0);
  });

  it('keeps streams isolated — draining one does not advance another', () => {
    // This is the property the whole design exists for. If it ever fails, adding a draw
    // to one voice has silently changed the music of every repo rendered so far.
    const reference = draw(createRng(SEED, 'voice:arp'), 8);

    const noisy = createRng(SEED, 'voice:lead');
    const arp = createRng(SEED, 'voice:arp');
    const interleaved: number[] = [];
    for (let i = 0; i < 8; i++) {
      noisy();
      noisy();
      interleaved.push(arp());
    }

    expect(interleaved).toStrictEqual(reference);
  });

  it('cannot confuse the seed/stream boundary', () => {
    // Without the length prefix in streamKey these two would be the same generator.
    expect(draw(createRng('a:b', 'c'), 8)).not.toStrictEqual(draw(createRng('a', 'b:c'), 8));
  });

  it('stays inside [0, 1)', () => {
    const rng = createRng(SEED, 'range');
    for (let i = 0; i < 100_000; i++) {
      const value = rng();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('is uniformly distributed', () => {
    // Deterministic input, so this cannot flake — it only fails if the generator breaks.
    const rng = createRng(SEED, 'distribution');
    const buckets = new Array<number>(10).fill(0);
    const samples = 100_000;
    let sum = 0;

    for (let i = 0; i < samples; i++) {
      const value = rng();
      sum += value;
      const bucket = Math.floor(value * 10);
      buckets[bucket] = (buckets[bucket] ?? 0) + 1;
    }

    expect(sum / samples).toBeCloseTo(0.5, 2);
    for (const [index, count] of buckets.entries()) {
      expect(count, `bucket ${index}`).toBeGreaterThan(samples / 10 - 500);
      expect(count, `bucket ${index}`).toBeLessThan(samples / 10 + 500);
    }
  });

  it('matches its recorded output', () => {
    // A golden vector, not a smoke test. "The same commit SHA produces the same audio,
    // forever" means swapping the generator is a breaking change to every repo's music.
    // If this fails, either the change was unintended or these numbers need updating in
    // the same commit that justifies it.
    const expected = [
      0.727868772577, 0.191582350992, 0.826430230867, 0.438390691532, 0.628794755321,
      0.3171344148,
    ];
    const actual = draw(createRng(SEED, 'skeleton'), expected.length);
    for (const [i, value] of expected.entries()) {
      expect(actual[i], `draw ${i}`).toBeCloseTo(value, 12);
    }
  });

  it('drives pickProgression deterministically', () => {
    const first = pickProgression('aeolian', createRng(SEED, 'skeleton'));
    const second = pickProgression('aeolian', createRng(SEED, 'skeleton'));
    expect(first.id).toBe(second.id);
    expect(first.modes).toContain('aeolian');
  });
});

describe('hashString', () => {
  it('is stable for the same input', () => {
    expect(hashString('packages/react-dom')).toBe(hashString('packages/react-dom'));
  });

  it('separates inputs that differ by one character', () => {
    expect(hashString('packages/react-dom')).not.toBe(hashString('packages/react-dam'));
  });

  it('returns an unsigned 32-bit integer', () => {
    for (const text of ['', 'a', 'packages/react-reconciler/src/ReactFiberHooks.js', SEED]) {
      const hash = hashString(text);
      expect(Number.isInteger(hash), text).toBe(true);
      expect(hash, text).toBeGreaterThanOrEqual(0);
      expect(hash, text).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it('matches its recorded output', () => {
    expect(hashString('packages/react-dom')).toBe(3565076923);
  });
});

describe('unitHash', () => {
  it('stays inside [0, 1)', () => {
    for (const entry of ['', 'a', 'packages/react-dom', 'packages/scheduler', SEED]) {
      expect(unitHash(entry), entry).toBeGreaterThanOrEqual(0);
      expect(unitHash(entry), entry).toBeLessThan(1);
    }
  });

  it('does not depend on when it is called', () => {
    // The point of unitHash: a file's musical choice must not move when the number of
    // draws around it changes.
    const before = unitHash('packages/react-dom');
    const rng = createRng(SEED, 'noise');
    draw(rng, 100);
    expect(unitHash('packages/react-dom')).toBe(before);
  });

  it('matches its recorded output', () => {
    expect(unitHash('packages/react-dom')).toBeCloseTo(0.830059154658, 12);
  });
});
