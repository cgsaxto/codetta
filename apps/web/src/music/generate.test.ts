import { describe, expect, it } from 'vitest';
import { reactFeatures } from '../features/fixture';
import type { RepoFeatures } from '../features/types';
import { generateScore } from './generate';
import {
  MAX_CONCURRENT_NOTES,
  TICKS_PER_BAR,
  VOICE_REGISTERS,
  barToTick,
  validateScore,
} from './score';
import { buildSkeleton } from './skeleton';
import { bassEvents } from './voices/bass';
import { padEvents } from './voices/pad';

function featuresWith(seed: string, linesOfCode = reactFeatures.totals.linesOfCode) {
  return {
    ...reactFeatures,
    seed,
    totals: { ...reactFeatures.totals, linesOfCode },
  } satisfies RepoFeatures;
}

function syntheticSeed(n: number): string {
  return n.toString(16).padStart(8, '0');
}

describe('pad', () => {
  it('sounds a chord in every bar of the piece', () => {
    const skeleton = buildSkeleton(reactFeatures);
    const events = padEvents(skeleton);
    const bars = new Set(events.map((event) => event.tick / TICKS_PER_BAR));
    expect(bars.size).toBe(skeleton.bars);
    expect(events).toHaveLength(skeleton.bars * 3);
  });

  it('stays inside the pad register', () => {
    const [lo, hi] = VOICE_REGISTERS.pad;
    for (const event of padEvents(buildSkeleton(reactFeatures))) {
      expect(event.midi).toBeGreaterThanOrEqual(lo);
      expect(event.midi).toBeLessThanOrEqual(hi);
    }
  });

  it('repeats the four-bar loop rather than drifting', () => {
    const skeleton = buildSkeleton(reactFeatures);
    const events = padEvents(skeleton);
    const pitchesInBar = (bar: number) =>
      events.filter((event) => event.tick === barToTick(bar)).map((event) => event.midi);
    expect(pitchesInBar(4)).toStrictEqual(pitchesInBar(0));
    expect(pitchesInBar(9)).toStrictEqual(pitchesInBar(1));
  });

  it('is not driven by any repo feature', () => {
    // Pad and bass are the safety net that makes every other voice work. Nothing about the
    // code being sonified may reach them — only the seed and the size, via the skeleton.
    const mutated: RepoFeatures = {
      ...reactFeatures,
      languages: [{ name: 'Go', share: 1, files: 40 }],
      modules: reactFeatures.modules.map((module) => ({
        ...module,
        avgNestingDepth: 9,
        maxNestingDepth: 14,
        avgFunctionLength: 80,
        cyclomaticDensity: 0.9,
        commentRatio: 0.9,
        asyncRatio: 0.9,
      })),
      timeline: [],
    };
    expect(generateScore(mutated).events).toStrictEqual(generateScore(reactFeatures).events);
  });
});

describe('bass', () => {
  it('plays the root on beats 1 and 3 of every bar', () => {
    const skeleton = buildSkeleton(reactFeatures);
    const events = bassEvents(skeleton);
    expect(events).toHaveLength(skeleton.bars * 2);
    for (const event of events) {
      expect(event.tick % TICKS_PER_BAR === 0 || event.tick % TICKS_PER_BAR === 8).toBe(true);
    }
  });

  it('leaves a gap so repeated roots do not smear together', () => {
    for (const event of bassEvents(buildSkeleton(reactFeatures))) {
      expect(event.durationTicks).toBe(7);
    }
  });

  it('stays inside the bass register', () => {
    const [lo, hi] = VOICE_REGISTERS.bass;
    for (const event of bassEvents(buildSkeleton(reactFeatures))) {
      expect(event.midi).toBeGreaterThanOrEqual(lo);
      expect(event.midi).toBeLessThanOrEqual(hi);
    }
  });

  it('never overlaps itself, so a mono synth is enough', () => {
    const events = bassEvents(buildSkeleton(reactFeatures));
    for (let i = 1; i < events.length; i++) {
      const previous = events[i - 1];
      const current = events[i];
      if (!previous || !current) continue;
      expect(previous.tick + previous.durationTicks).toBeLessThanOrEqual(current.tick);
    }
  });
});

describe('generateScore', () => {
  it('produces a valid score for the react fixture', () => {
    expect(validateScore(generateScore(reactFeatures))).toStrictEqual([]);
  });

  it('is deterministic', () => {
    expect(generateScore(reactFeatures)).toStrictEqual(generateScore(reactFeatures));
  });

  it('stays valid across seeds and repo sizes', () => {
    for (let n = 0; n < 200; n++) {
      const seed = syntheticSeed(n);
      const linesOfCode = 10 ** (1 + (n % 7));
      const score = generateScore(featuresWith(seed, linesOfCode));
      expect(validateScore(score), `${seed} @ ${linesOfCode} LOC`).toStrictEqual([]);
    }
  });

  it('leaves headroom under the polyphony ceiling for the voices still to come', () => {
    // Pad is three notes and bass is one. If this ever reaches the ceiling, adding the
    // lead is impossible without dropping something.
    const score = generateScore(reactFeatures);
    const totalTicks = barToTick(score.bars);
    const active = new Array<number>(totalTicks).fill(0);
    for (const event of score.events) {
      for (let tick = event.tick; tick < event.tick + event.durationTicks; tick++) {
        const slot = active[tick];
        if (slot !== undefined) active[tick] = slot + 1;
      }
    }
    expect(Math.max(...active)).toBeLessThanOrEqual(MAX_CONCURRENT_NOTES / 2);
  });

  it('matches its recorded opening bar', () => {
    const score = generateScore(reactFeatures);
    const openingBar = score.events
      .filter((event) => event.tick === 0)
      .map((event) => [event.voice, event.midi]);
    // G Dorian, 'current' loop. The pad opens on G minor in second inversion — D3, Bb3,
    // G4 — because the opening chord is placed nearest an even spread of C3–C5 rather
    // than in root position. Bass takes the root at G1.
    expect(openingBar).toStrictEqual([
      ['pad', 50],
      ['pad', 58],
      ['pad', 67],
      ['bass', 31],
    ]);
  });
});
