import { describe, expect, it } from 'vitest';
import type { RepoFeatures } from '@codetta/schema';
import { reactFeatures, requestsFeatures } from '../features/fixture';
import { fieldFor } from './layout';

const fixtures: ReadonlyArray<readonly [string, RepoFeatures]> = [
  ['react', reactFeatures],
  ['requests', requestsFeatures],
];

describe('fieldFor', () => {
  it.each(fixtures)('lays %s out inside the unit square', (_name, features) => {
    // Everything is 0–1 because Phase 4 renders this square and vertical as well as wide.
    // A layout that leaked pixels would have to be rewritten for each aspect ratio.
    for (const column of fieldFor(features)) {
      expect(column.x).toBeGreaterThanOrEqual(0);
      expect(column.x + column.width).toBeLessThanOrEqual(1.0001);
      expect(column.width).toBeGreaterThan(0);

      for (const mark of column.marks) {
        expect(mark.y).toBeGreaterThanOrEqual(0);
        expect(mark.y).toBeLessThanOrEqual(1);
        expect(mark.indent + mark.length).toBeLessThanOrEqual(1.0001);
        expect(mark.length).toBeGreaterThan(0);
      }
    }
  });

  it.each(fixtures)('ranks %s columns by size, widest first', (_name, features) => {
    // The picture and the music are ranked the same way: the widest column is the module the
    // loudest voice belongs to. If these disagreed, the thing you look at and the thing you
    // hear would be telling different stories about the same repository.
    const widths = fieldFor(features).map((column) => column.width);
    expect(widths).toStrictEqual([...widths].sort((a, b) => b - a));
  });

  it.each(fixtures)('gives every %s column the voice that plays it', (_name, features) => {
    const columns = fieldFor(features);
    expect(columns.map((column) => column.voice)).toStrictEqual(
      ['lead', 'arp', 'bell', 'texture', 'kick', 'hat'].slice(0, columns.length),
    );
  });

  it('draws only the modules that are actually playing', () => {
    // A document can hold six modules while the language-diversity table gives it four
    // voices. Drawing the other two would put something on screen that never makes a sound.
    const columns = fieldFor(requestsFeatures);
    expect(columns.length).toBeLessThanOrEqual(requestsFeatures.modules.length);
    for (const column of columns) {
      expect(requestsFeatures.modules.map((module) => module.path)).toContain(column.path);
    }
  });

  it('places files in the repository’s own traversal order, not the column’s', () => {
    // What makes a descending line a reading of the repository rather than six unrelated
    // lists: a file's height is its place in the timeline, so the line crosses the columns in
    // the order the parser actually met the files.
    const columns = fieldFor(reactFeatures);
    const byY = columns
      .flatMap((column) => column.marks.map((mark) => mark.y))
      .sort((a, b) => a - b);

    const timelineY = reactFeatures.timeline
      .filter((entry) => columns.some((column) => column.path === entry.modulePath))
      .map((entry) => entry.index / (reactFeatures.timeline.length - 1))
      .sort((a, b) => a - b);

    expect(byY).toStrictEqual(timelineY);
  });

  it('survives a repository the schema allows but nobody would enjoy', () => {
    // Shares that are all zero, an empty timeline, one module. None is impossible: a
    // repository of empty files rounds every share to zero, and a flat repository has no
    // timeline at all because root-level files have no module to sit under.
    const bare: RepoFeatures = {
      ...reactFeatures,
      languages: [{ name: 'Go', share: 1, files: 1 }],
      modules: [{ ...reactFeatures.modules[0]!, path: 'x', share: 0 }],
      timeline: [],
    };

    const columns = fieldFor(bare);
    expect(columns).toHaveLength(1);
    expect(columns[0]?.width).toBeGreaterThan(0);
    expect(columns[0]?.marks).toStrictEqual([]);
  });

  it('returns nothing rather than dividing by nothing when there are no modules', () => {
    expect(fieldFor({ ...reactFeatures, modules: [], timeline: [] })).toStrictEqual([]);
  });
});
