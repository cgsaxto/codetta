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
import { buildSkeleton, chordLoop } from './skeleton';
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
    for (const bar of bars) {
      const inBar = events.filter((event) => event.tick === barToTick(bar));
      // Two when the third was dropped, three when it was high enough to keep.
      expect(inBar.length, `bar ${bar}`).toBeGreaterThanOrEqual(2);
      expect(inBar.length, `bar ${bar}`).toBeLessThanOrEqual(3);
    }
  });

  it('drops the third rather than letting it muddy the low register', () => {
    const skeleton = buildSkeleton(reactFeatures);
    const chords = chordLoop(skeleton);
    const events = padEvents(skeleton);

    for (const [bar, chord] of chords.entries()) {
      const thirdClass = (((chord.midi[1] ?? 0) % 12) + 12) % 12;
      const played = events.filter((event) => event.tick === barToTick(bar));
      for (const event of played) {
        const isThird = ((event.midi % 12) + 12) % 12 === thirdClass;
        if (isThird) expect(event.midi, `bar ${bar}`).toBeGreaterThanOrEqual(60);
      }
      // The root and the fifth always survive, so the chord is never reduced to one note.
      expect(played.length, `bar ${bar}`).toBeGreaterThanOrEqual(2);
    }
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
    const safetyNet = (features: RepoFeatures) =>
      generateScore(features).events.filter(
        (event) => event.voice === 'pad' || event.voice === 'bass',
      );

    // Only pad and bass. Every other voice is supposed to move when the features do — that
    // is the whole point of them.
    expect(safetyNet(mutated)).toStrictEqual(safetyNet(reactFeatures));
    expect(generateScore(mutated).events).not.toStrictEqual(
      generateScore(reactFeatures).events,
    );
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
    // Pad is two or three notes, bass one, lead one. Arp, bell, texture and percussion are
    // still to come, so hitting the ceiling now would mean dropping something later.
    const score = generateScore(reactFeatures);
    const totalTicks = barToTick(score.bars);
    const active = new Array<number>(totalTicks).fill(0);
    for (const event of score.events) {
      for (let tick = event.tick; tick < event.tick + event.durationTicks; tick++) {
        const slot = active[tick];
        if (slot !== undefined) active[tick] = slot + 1;
      }
    }
    expect(Math.max(...active)).toBeLessThanOrEqual(MAX_CONCURRENT_NOTES - 2);
  });

  it('matches its recorded opening bar', () => {
    const score = generateScore(reactFeatures);
    const openingBar = score.events
      .filter((event) => event.tick === 0)
      .map((event) => [event.voice, event.midi]);
    // G Dorian, 'current' loop. The pad opens on G minor spread across G3, D4 and Bb4 —
    // a fifth then a minor sixth. A closer voicing would score better on movement alone;
    // the spacing rule is what keeps the bottom interval open. Bass takes the root at G1,
    // and the lead states its motif from the downbeat.
    expect(openingBar).toStrictEqual([
      ['pad', 55],
      ['pad', 62],
      ['pad', 70],
      ['bass', 31],
      ['lead', 70],
    ]);
  });
});
