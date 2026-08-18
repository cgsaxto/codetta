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
});
