import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { REPO_FEATURES_KEYS } from '@codetta/schema';
import { generateScore } from '../music/generate';
import { GALLERY } from './gallery';

/**
 * The gallery is loaded by a glob, and a glob that matches nothing resolves to an empty
 * object rather than failing. A landing page that is the gallery would then ship as a blank
 * page, having passed every type check on the way.
 */
describe('GALLERY', () => {
  it('found the committed documents', () => {
    expect(GALLERY.length).toBe(8);
  });

  it('covers all four supported languages', () => {
    // The reason the list is what it is. A gallery that drifted to six JavaScript
    // repositories would still load, and would quietly stop demonstrating the range.
    const languages = new Set(GALLERY.map((entry) => entry.repo.primaryLanguage));
    expect([...languages].sort()).toStrictEqual(['Go', 'JavaScript', 'Python', 'TypeScript']);
  });

  it('holds real documents this build can read', () => {
    for (const entry of GALLERY) {
      const where = `${entry.repo.owner}/${entry.repo.name}`;
      expect(entry.schemaVersion, where).toBe(1);
      for (const key of REPO_FEATURES_KEYS) expect(entry, where).toHaveProperty(key);
      expect(entry.repo.commitSha, where).toMatch(/^[0-9a-f]{40}$/);
      expect(entry.modules.length, where).toBeGreaterThan(0);
    }
  });

  it('plays: every tile generates a valid score', () => {
    // One click has to produce music. A document that parsed but could not be turned into a
    // score would be a tile that looks fine and does nothing.
    for (const entry of GALLERY) {
      const score = generateScore(entry);
      expect(score.events.length, `${entry.repo.name}`).toBeGreaterThan(0);
    }
  });

  it('has no two tiles that are the same repository', () => {
    const names = GALLERY.map((entry) => `${entry.repo.owner}/${entry.repo.name}`);
    expect(new Set(names).size).toBe(names.length);
  });

  it('is described accurately by the README', () => {
    /*
     * The README's table used to be written by hand, and it was fiction: it claimed react
     * was D Dorian at 104 BPM over 268,430 lines when the real answer was C Aeolian at 120
     * over 293,684, and four of the six repositories it listed are in languages the parser
     * cannot read at all. It is the first file a stranger reads, in a repository that is
     * public from day one, and it was the same class of mistake as the hand-authored fixture
     * — plausible numbers nobody generated.
     *
     * So the claim is checked rather than maintained. If the gallery is refreshed and the
     * table is not, this fails and says which line is wrong.
     */
    const readme = readFileSync('../../README.md', 'utf8');

    for (const entry of [...GALLERY].sort(
      (a, b) => a.totals.linesOfCode - b.totals.linesOfCode,
    )) {
      const score = generateScore(entry);
      const name = `${entry.repo.owner}/${entry.repo.name}`;
      const mode = score.mode.charAt(0).toUpperCase() + score.mode.slice(1);
      const row =
        `| [${name}](https://github.com/${name}) | ${entry.repo.primaryLanguage} | ` +
        `${entry.totals.linesOfCode.toLocaleString('en-US')} | ${score.root} ${mode} · ${score.bpm} BPM |`;

      // Whitespace-insensitive: prettier aligns the columns, and column alignment is not a
      // claim about anything.
      const squash = (text: string) => text.replace(/[ \t]+/g, ' ');
      expect(squash(readme), `README is missing or wrong for ${name}`).toContain(squash(row));
    }
  });
});
