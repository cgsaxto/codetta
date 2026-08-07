import { describe, expect, it } from 'vitest';
import { reactFeatures } from '../features/fixture';
import type { RepoFeatures } from '../features/types';
import { MODE_NAMES, ROOT_NAMES } from './progressions';
import { MAX_BPM, SECTION_ORDER, validateScore } from './score';
import {
  TEMPOS,
  buildSkeleton,
  chordLoop,
  scoreFrom,
  structureFor,
  tempoFor,
} from './skeleton';

function featuresWith(overrides: { seed?: string; linesOfCode?: number }): RepoFeatures {
  return {
    ...reactFeatures,
    seed: overrides.seed ?? reactFeatures.seed,
    totals: {
      ...reactFeatures.totals,
      linesOfCode: overrides.linesOfCode ?? reactFeatures.totals.linesOfCode,
    },
  };
}

/** Seeds are the first 8 hex chars of a commit SHA. */
function syntheticSeed(n: number): string {
  return n.toString(16).padStart(8, '0');
}

describe('palette order', () => {
  // These arrays are indexed by the seeded rng, so their order is part of the output
  // contract. Reordering either one silently changes the key of every repo.
  it('is locked', () => {
    expect(ROOT_NAMES).toStrictEqual(['C', 'D', 'Eb', 'F', 'G', 'A']);
    expect(MODE_NAMES).toStrictEqual(['dorian', 'aeolian', 'lydian', 'mixolydian']);
  });
});

describe('tempo', () => {
  it('is a 15-entry palette from 72 to the ceiling in 4 BPM steps', () => {
    expect(TEMPOS).toHaveLength(15);
    expect(TEMPOS[0]).toBe(72);
    expect(TEMPOS.at(-1)).toBe(MAX_BPM);
    expect(TEMPOS.map((bpm, i) => bpm - 72 - i * 4)).toStrictEqual(new Array(15).fill(0));
  });

  it('maps repo size onto the palette on a log scale', () => {
    expect(tempoFor(1_000)).toBe(72);
    expect(tempoFor(10_000)).toBe(92);
    expect(tempoFor(100_000)).toBe(108);
    expect(tempoFor(1_000_000)).toBe(128);
  });

  it('clamps rather than running off either end', () => {
    expect(tempoFor(0)).toBe(72);
    expect(tempoFor(1)).toBe(72);
    expect(tempoFor(-5)).toBe(72);
    expect(tempoFor(500_000_000)).toBe(MAX_BPM);
  });

  it('never decreases as a repo grows', () => {
    let previous = 0;
    for (let loc = 1; loc <= 5_000_000; loc = Math.ceil(loc * 1.2)) {
      const bpm = tempoFor(loc);
      expect(bpm, `${loc} LOC`).toBeGreaterThanOrEqual(previous);
      expect(TEMPOS, `${loc} LOC`).toContain(bpm);
      previous = bpm;
    }
  });
});

describe('structureFor', () => {
  it('covers every tempo in the palette', () => {
    for (const bpm of TEMPOS) {
      expect(() => structureFor(bpm), `${bpm} BPM`).not.toThrow();
    }
  });

  it('refuses a tempo above the ceiling instead of guessing', () => {
    expect(() => structureFor(MAX_BPM + 4)).toThrow(/ceiling/);
  });

  it('tiles the piece in canonical order with 4-bar sections', () => {
    for (const bpm of TEMPOS) {
      const { bars, sections } = structureFor(bpm);
      const label = `${bpm} BPM`;

      expect(
        sections.map((section) => section.name),
        label,
      ).toStrictEqual([...SECTION_ORDER]);

      let cursor = 0;
      for (const section of sections) {
        expect(section.startBar, `${label} ${section.name}`).toBe(cursor);
        expect(section.bars % 4, `${label} ${section.name}`).toBe(0);
        cursor += section.bars;
      }
      expect(cursor, label).toBe(bars);
    }
  });

  it('lands every tempo inside the 60–90 s window', () => {
    // This is the promise the three templates exist to keep. A single fixed bar count
    // cannot make it: 40 bars at 72 BPM is 133 seconds.
    for (const bpm of TEMPOS) {
      const { bars, sections } = structureFor(bpm);
      const score = {
        seed: 'test',
        bpm,
        root: 'C' as const,
        mode: 'aeolian' as const,
        progressionId: 'nightfall',
        bars,
        sections,
        events: [],
        timbre: {},
      };
      expect(validateScore(score), `${bpm} BPM`).toStrictEqual([]);
    }
  });
});

describe('buildSkeleton', () => {
  it('is deterministic', () => {
    expect(buildSkeleton(reactFeatures)).toStrictEqual(buildSkeleton(reactFeatures));
  });

  it('depends on the seed, not on the rest of the document', () => {
    const a = buildSkeleton(featuresWith({ seed: 'aaaaaaaa' }));
    const b = buildSkeleton(featuresWith({ seed: 'bbbbbbbb' }));
    expect([a.root, a.mode, a.progression.id]).not.toStrictEqual([
      b.root,
      b.mode,
      b.progression.id,
    ]);
  });

  it('takes tempo from size and nothing else', () => {
    const small = buildSkeleton(featuresWith({ linesOfCode: 2_000 }));
    const large = buildSkeleton(featuresWith({ linesOfCode: 900_000 }));
    expect(small.bpm).toBeLessThan(large.bpm);
    expect(small.root).toBe(large.root);
    expect(small.mode).toBe(large.mode);
  });

  it('only ever picks a progression verified in the mode it chose', () => {
    for (let n = 0; n < 500; n++) {
      const skeleton = buildSkeleton(featuresWith({ seed: syntheticSeed(n) }));
      expect(skeleton.progression.modes, `seed ${syntheticSeed(n)}`).toContain(skeleton.mode);
    }
  });

  it('reaches every root and every mode across seeds', () => {
    const roots = new Set<string>();
    const modes = new Set<string>();
    for (let n = 0; n < 500; n++) {
      const skeleton = buildSkeleton(featuresWith({ seed: syntheticSeed(n) }));
      roots.add(skeleton.root);
      modes.add(skeleton.mode);
    }
    expect([...roots].sort()).toStrictEqual([...ROOT_NAMES].sort());
    expect([...modes].sort()).toStrictEqual([...MODE_NAMES].sort());
  });

  it('always yields a structurally valid score', () => {
    for (let n = 0; n < 200; n++) {
      const seed = syntheticSeed(n);
      const linesOfCode = 10 ** (1 + (n % 7));
      const skeleton = buildSkeleton(featuresWith({ seed, linesOfCode }));
      expect(validateScore(scoreFrom(skeleton)), `${seed} @ ${linesOfCode} LOC`).toStrictEqual(
        [],
      );
    }
  });

  it('matches its recorded output for the react fixture', () => {
    // "The same commit SHA always produces the same audio, forever" made concrete.
    const skeleton = buildSkeleton(reactFeatures);
    expect({
      root: skeleton.root,
      mode: skeleton.mode,
      bpm: skeleton.bpm,
      progression: skeleton.progression.id,
      bars: skeleton.bars,
    }).toStrictEqual({
      root: 'G',
      mode: 'dorian',
      bpm: 116,
      progression: 'current',
      bars: 40,
    });
  });
});

describe('chordLoop', () => {
  it('realises four bars in the skeleton key', () => {
    const skeleton = buildSkeleton(reactFeatures);
    const chords = chordLoop(skeleton, { octave: 3 });
    expect(chords).toHaveLength(4);
    // G3 is MIDI 55, and the loop always opens on the tonic.
    expect(chords[0]?.midi[0]).toBe(55);
    expect(chords.every((chord) => chord.quality === 'maj' || chord.quality === 'min')).toBe(
      true,
    );
  });
});

describe('scoreFrom', () => {
  it('carries the skeleton into the score', () => {
    const skeleton = buildSkeleton(reactFeatures);
    const score = scoreFrom(skeleton);
    expect(score.progressionId).toBe(skeleton.progression.id);
    expect(score.bars).toBe(skeleton.bars);
    expect(score.sections).toStrictEqual(skeleton.sections);
  });

  it('sorts events so an unordered score cannot be emitted', () => {
    const skeleton = buildSkeleton(reactFeatures);
    const score = scoreFrom(skeleton, [
      { voice: 'bass', tick: 8, durationTicks: 4, midi: 31, velocity: 0.8 },
      { voice: 'bass', tick: 0, durationTicks: 4, midi: 31, velocity: 0.8 },
    ]);
    expect(score.events.map((event) => event.tick)).toStrictEqual([0, 8]);
    expect(validateScore(score)).toStrictEqual([]);
  });
});
