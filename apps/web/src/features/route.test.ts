import { describe, expect, it } from 'vitest';
import { pathForRepo, repoFromPath } from './route';

describe('repoFromPath', () => {
  it('reads the address a shared link carries', () => {
    expect(repoFromPath('/r/facebook/react')).toStrictEqual({
      owner: 'facebook',
      name: 'react',
    });
  });

  it('ignores everything that is not that address', () => {
    // The front page included: it has no repository, and answering with one would play
    // something nobody asked for.
    for (const path of ['/', '/about', '/r', '/r/', '/r/facebook', '/rr/a/b']) {
      expect(repoFromPath(path), path).toBeUndefined();
    }
  });

  it('holds the same line on owners the input box does', () => {
    // Shared through the one parser, so a typed repository and a linked one cannot disagree
    // about what an owner may look like. A hostname may not.
    expect(repoFromPath('/r/gitlab.com/vuejs')).toBeUndefined();
    expect(repoFromPath('/r/vercel/next.js')).toStrictEqual({
      owner: 'vercel',
      name: 'next.js',
    });
  });

  it('round-trips with the path it builds', () => {
    for (const [owner, name] of [
      ['psf', 'requests'],
      ['microsoft', 'TypeScript'],
      ['vercel', 'next.js'],
    ] as const) {
      expect(repoFromPath(pathForRepo(owner, name))).toStrictEqual({ owner, name });
    }
  });
});
