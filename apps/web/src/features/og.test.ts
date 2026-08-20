import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { generateScore } from '../music/generate';
import { GALLERY } from './gallery';

/**
 * The share cards are build output, committed, and served by a Go process that cannot check
 * them — apps/api substitutes strings out of `og/manifest.json` and has no way to know that
 * the piece it is describing has changed key since.
 *
 * So the check lives here, where the music is. It compares the manifest against freshly
 * generated scores, which catches the case that actually happens: a change to the mapping
 * moves every repository's key, and eight links quietly start unfurling with a sentence that
 * is no longer true. The fix is `pnpm --filter @codetta/web og`, in the same commit.
 *
 * What it cannot check is the pictures. A screenshot's correctness is not expressible here,
 * and asserting on its bytes would fail on a font update rather than on a real change. The
 * manifest is the part with claims in it; the images are looked at by a person.
 */
const OG = new URL('../../public/og/', import.meta.url).pathname;

interface Card {
  owner: string;
  name: string;
  title: string;
  description: string;
  image: string;
}

describe('the share cards', () => {
  const manifest = JSON.parse(readFileSync(`${OG}manifest.json`, 'utf8')) as Card[];

  it('describes every gallery repository, and nothing else', () => {
    const listed = manifest.map((card) => `${card.owner}/${card.name}`).sort();
    const gallery = GALLERY.map((entry) => `${entry.repo.owner}/${entry.repo.name}`).sort();

    expect(listed).toStrictEqual(gallery);
  });

  it('still says what the music does', () => {
    for (const entry of GALLERY) {
      const card = manifest.find(
        (listed) => listed.owner === entry.repo.owner && listed.name === entry.repo.name,
      );
      const where = `${entry.repo.owner}/${entry.repo.name}`;
      expect(card, where).toBeDefined();

      const score = generateScore(entry);
      expect(card!.description, where).toContain(`${score.bpm} BPM`);
      expect(card!.description, where).toContain(score.root);
      expect(card!.description, where).toContain(entry.repo.primaryLanguage);
    }
  });

  it('points at images that exist', () => {
    // The manifest names paths the browser will request. A card that unfurls as a broken
    // image is worse than no card, because a platform caches the miss.
    for (const card of manifest) {
      expect(existsSync(`${OG}${card.image.replace('/og/', '')}`), card.image).toBe(true);
    }
    expect(existsSync(`${OG}cover.png`), 'the fallback card').toBe(true);
  });
});
