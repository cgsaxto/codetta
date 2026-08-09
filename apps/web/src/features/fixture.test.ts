import { describe, expect, it } from 'vitest';
import { FIXTURES } from './fixture';

/**
 * Every assertion here restates a rule from docs/features-schema.md.
 *
 * These began as a guard against hand-authored fixtures drifting from the spec. The
 * fixtures are real API output now, which makes this the other half of the conformance
 * story: packages/schema proves the two languages agree about the document's shape, and
 * this proves apps/api actually honours the rules that shape cannot express — ordering,
 * rounding, ratios that must sum to one, timeline entries that must sit under their module.
 */

const isCount = (n: number) => Number.isInteger(n) && n >= 0;
const isRatio = (n: number) => n >= 0 && n <= 1;
const isRounded = (n: number) => Number(n.toFixed(4)) === n;

describe.each(Object.entries(FIXTURES))('fixtures/%s.json', (_name, features) => {
  it('declares the current schema version', () => {
    expect(features.schemaVersion).toBe(1);
  });

  it('derives seed from the first 8 chars of commitSha', () => {
    expect(features.repo.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(features.seed).toBe(features.repo.commitSha.slice(0, 8));
  });

  it('reports totals as non-negative integers', () => {
    for (const [key, value] of Object.entries(features.totals)) {
      expect(isCount(value), `totals.${key} = ${value}`).toBe(true);
    }
  });

  it('has language shares that are ratios summing to 1', () => {
    for (const language of features.languages) {
      expect(isRatio(language.share), `${language.name} share`).toBe(true);
      expect(isCount(language.files), `${language.name} files`).toBe(true);
    }
    const total = features.languages.reduce((sum, l) => sum + l.share, 0);
    expect(total).toBeCloseTo(1, 4);
  });

  it('holds at most 6 modules, ordered by share descending', () => {
    expect(features.modules.length).toBeGreaterThan(0);
    expect(features.modules.length).toBeLessThanOrEqual(6);

    const shares = features.modules.map((m) => m.share);
    expect(shares).toStrictEqual([...shares].sort((a, b) => b - a));

    // Modules are only the top 6 directories, so they need not sum to 1 — but summing
    // above 1 would mean LOC is being double-counted somewhere in aggregation.
    expect(shares.reduce((sum, s) => sum + s, 0)).toBeLessThanOrEqual(1);
  });

  it('keeps every module ratio inside 0–1', () => {
    for (const module of features.modules) {
      for (const key of ['share', 'cyclomaticDensity', 'commentRatio', 'asyncRatio'] as const) {
        expect(isRatio(module[key]), `${module.path}.${key} = ${module[key]}`).toBe(true);
      }
      expect(module.avgNestingDepth).toBeLessThanOrEqual(module.maxNestingDepth);
      expect(isCount(module.files), `${module.path}.files`).toBe(true);
      expect(isCount(module.linesOfCode), `${module.path}.linesOfCode`).toBe(true);
    }
  });

  it('rounds every float to 4 decimal places', () => {
    for (const module of features.modules) {
      for (const [key, value] of Object.entries(module)) {
        if (typeof value !== 'number') continue;
        expect(isRounded(value), `${module.path}.${key} = ${value}`).toBe(true);
      }
    }
    for (const language of features.languages) {
      expect(isRounded(language.share), `${language.name} share`).toBe(true);
    }
  });

  it('caps the timeline at 256 entries and indexes them sequentially', () => {
    expect(features.timeline.length).toBeLessThanOrEqual(256);
    expect(features.timeline.map((entry) => entry.index)).toStrictEqual(
      features.timeline.map((_entry, i) => i),
    );
  });

  it('orders the timeline lexicographically by path', () => {
    const paths = features.timeline.map((entry) => entry.path);
    // Byte-wise, not locale-aware: `-` (0x2D) sorts before `/` (0x2F), so `react-dom/…`
    // precedes `react/…`. localeCompare would order these the other way round.
    const sorted = [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(paths).toStrictEqual(sorted);
  });

  it('attributes every timeline entry to a declared module', () => {
    const modulePaths = new Set(features.modules.map((m) => m.path));
    for (const entry of features.timeline) {
      expect(modulePaths, `${entry.path}`).toContain(entry.modulePath);
      expect(entry.path.startsWith(`${entry.modulePath}/`), `${entry.path}`).toBe(true);
    }
  });

  it('reports timeline counts as non-negative integers', () => {
    for (const entry of features.timeline) {
      for (const key of [
        'linesOfCode',
        'functions',
        'maxNesting',
        'branches',
        'commentLines',
      ] as const) {
        expect(isCount(entry[key]), `${entry.path}.${key} = ${entry[key]}`).toBe(true);
      }
    }
  });
});
