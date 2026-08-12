import type { RepoFeatures } from '@codetta/schema';
import { MODULE_VOICE_ORDER, moduleVoiceCount } from '../music/arrangement';
import type { VoiceId } from '../music/score';

/**
 * The repository, as geometry.
 *
 * Every number here is 0–1 rather than a pixel. Phase 4 renders this square and vertical as
 * well as wide, and a layout that knows its own size would have to be rewritten for each; a
 * layout in unit space is placed by whoever is drawing it.
 *
 * ## What is being drawn, and why it is this
 *
 * A column per module, its width its share of the repository — so the widest column is the
 * one the loudest voice belongs to, and the picture and the music are ranked the same way.
 * Inside it, its files, each a rule as long as it has lines and indented as deep as it
 * nests. Indentation is what code looks like from far enough away to lose the letters, which
 * makes this the developer vernacular for "a listing" rather than an invented abstraction.
 *
 * Files are placed down the field by their position in the timeline, not within their own
 * column, because the timeline is the repository's own traversal order. A line descending
 * the field is then reading the repository in the order the parser read it, and it passes
 * through the columns in the order the files actually occur.
 */

export interface FileMark {
  /** 0–1 down the field: position in the repository's traversal order. */
  y: number;
  /** 0–1 across the column: how deeply this file nests. */
  indent: number;
  /**
   * 0–1 of the column's width, measured from the indent, so `indent + length` never leaves
   * the column. A deeply nested file therefore reads as shorter at the same line count,
   * which is what indented code does on a fixed page width.
   */
  length: number;
}

export interface Column {
  /** 0-based. Rank 0 is the largest module and the most prominent voice. */
  rank: number;
  path: string;
  /** The voice whose notes belong to this module, so an onset can find its column. */
  voice: VoiceId;
  /** 0–1 across the field. */
  x: number;
  width: number;
  marks: readonly FileMark[];
}

/**
 * A floor under the shortest file, so a 3-line module is a mark rather than nothing, and a
 * ceiling on indentation, so a repository whose deepest file nests twice does not get the
 * same dramatic staircase as one that nests nine times.
 */
const MIN_LENGTH = 0.12;
const MIN_INDENT_SCALE = 6;

/** Gap between columns, as a fraction of the field. Enough to read them as separate. */
const GUTTER = 0.012;

export function fieldFor(features: RepoFeatures): Column[] {
  // The modules that became voices, which is what makes a column a thing you can hear.
  // A module past the voice count is in the document but is not playing, and drawing it
  // would put something on screen that never makes a sound.
  const count = Math.min(moduleVoiceCount(features), features.modules.length);
  const modules = features.modules.slice(0, count);
  if (modules.length === 0) return [];

  const shares = modules.map((module) => Math.max(module.share, 0));
  const total = shares.reduce((sum, share) => sum + share, 0);
  // An even split when every share is zero, rather than a division by zero and a blank field.
  const weights =
    total > 0 ? shares.map((share) => share / total) : shares.map(() => 1 / count);

  const gutters = GUTTER * Math.max(0, modules.length - 1);
  const available = 1 - gutters;

  const longest = Math.max(1, ...features.timeline.map((entry) => entry.linesOfCode));
  const deepest = Math.max(
    MIN_INDENT_SCALE,
    ...features.timeline.map((entry) => entry.maxNesting),
  );
  const lastIndex = Math.max(1, features.timeline.length - 1);

  const columns: Column[] = [];
  let x = 0;

  for (const [rank, module] of modules.entries()) {
    const width = (weights[rank] ?? 0) * available;

    const marks = features.timeline
      .filter((entry) => entry.modulePath === module.path)
      .map((entry) => {
        // Half the column at most: an indent that can reach the right edge leaves no room
        // for the rule it is supposed to be pushing.
        const indent = Math.min(entry.maxNesting / deepest, 1) * 0.5;
        const run = MIN_LENGTH + (1 - MIN_LENGTH) * Math.min(entry.linesOfCode / longest, 1);
        return { y: entry.index / lastIndex, indent, length: run * (1 - indent) };
      });

    columns.push({
      rank,
      path: module.path,
      voice: MODULE_VOICE_ORDER[rank] ?? 'lead',
      x,
      width,
      marks,
    });
    x += width + GUTTER;
  }

  return columns;
}
