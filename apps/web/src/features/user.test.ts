import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseLogin, parseTarget } from './api';
import { fetchUserPick, pickSummary, type UserPick } from './user';

/**
 * `fetch` is stubbed rather than a server being started, for the same reason api.test.ts
 * stubs it: what is worth testing here is the translation, and every status is already
 * produced by apps/api's own offline tests against the real handler.
 */

function respond(status: number, body: unknown, ok = status >= 200 && status < 300) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve({ ok, status, json: () => Promise.resolve(body) } as Response)),
  );
}

const picked: UserPick = {
  login: 'torvalds',
  name: 'Linus Torvalds',
  repo: { owner: 'torvalds', name: 'pesconvert', stars: 60, primaryLanguage: 'Go' },
  passedOver: 2,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseLogin', () => {
  it('accepts a name and the profile URL it came from', () => {
    for (const input of [
      'torvalds',
      '  torvalds ',
      '@torvalds',
      'github.com/torvalds',
      'https://github.com/torvalds',
      'https://www.github.com/torvalds/',
      'https://github.com/torvalds?tab=repositories',
    ]) {
      expect(parseLogin(input), input).toBe('torvalds');
    }
  });

  it('holds to GitHub’s own rule for an account name', () => {
    // Not pedantry: apps/api puts this string inside a `user:` search qualifier, so a space
    // would let a visitor append qualifiers to a query the service makes with its own token.
    // Both sides check, and they check the same thing.
    for (const input of [
      '',
      '-leading',
      'trailing-',
      'has space',
      'has_underscore',
      'has.dot',
      'a'.repeat(40),
    ]) {
      expect(parseLogin(input), input).toBeUndefined();
    }
  });
});

describe('parseTarget', () => {
  it('tells a repository from a username without asking', () => {
    // The whole reason there is one box rather than two: the shapes are unambiguous, so the
    // visitor never has to classify their own input before typing it.
    expect(parseTarget('facebook/react')).toStrictEqual({
      kind: 'repo',
      repo: { owner: 'facebook', name: 'react' },
    });
    expect(parseTarget('torvalds')).toStrictEqual({ kind: 'user', login: 'torvalds' });
    expect(parseTarget('https://github.com/torvalds')).toStrictEqual({
      kind: 'user',
      login: 'torvalds',
    });
  });

  it('keeps a ref on a repository, which a username cannot carry', () => {
    expect(parseTarget('facebook/react@v18')).toStrictEqual({
      kind: 'repo',
      repo: { owner: 'facebook', name: 'react', ref: 'v18' },
    });
  });

  it('rejects what is neither', () => {
    for (const input of ['', '   ', 'not a name', 'has_underscore', '@']) {
      expect(parseTarget(input), input).toBeUndefined();
    }
  });
});

describe('fetchUserPick', () => {
  it('returns the repository the account resolved to', async () => {
    respond(200, picked);
    await expect(fetchUserPick('torvalds')).resolves.toStrictEqual(picked);
  });

  it('carries the service’s own sentence rather than a status code', async () => {
    // 422 is the one a visitor can act on — every repository they have is in a language we
    // do not read — so the message naming the four is the whole value of the response.
    respond(422, { error: 'none of ada’s repositories are in a language Codetta reads.' });
    await expect(fetchUserPick('ada')).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('language Codetta reads'),
    });
  });

  it('refuses a body that is not a pick', async () => {
    // A schema mismatch becomes one clear message here rather than an undefined read inside
    // the card renderer, which is where it would otherwise surface.
    respond(200, { login: 'torvalds', repo: { owner: 'torvalds' }, passedOver: 0 });
    await expect(fetchUserPick('torvalds')).rejects.toThrow(/does not understand/);
  });
});

describe('pickSummary', () => {
  it('does not claim more than the pick supports', () => {
    // "your most-starred repository" and "your most-starred repository Codetta can read" are
    // different claims. Which one is true depends on whether anything was skipped.
    expect(pickSummary(picked)).toContain('most-starred repository Codetta can read');
    expect(pickSummary({ ...picked, passedOver: 0 })).toContain('most-starred repository:');
    expect(pickSummary(picked)).toContain('torvalds/pesconvert');
  });
});
