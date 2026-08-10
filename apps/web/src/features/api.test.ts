import { afterEach, describe, expect, it, vi } from 'vitest';
import { reactFeatures } from './fixture';
import { ApiError, fetchFeatures, parseRepoRef } from './api';

/**
 * `fetch` is stubbed rather than a server being started. What is worth testing here is the
 * translation — a status into a sentence, a body into a typed document — and every one of
 * the statuses is already produced by apps/api's own offline tests against a real handler.
 */

function respond(status: number, body: unknown, ok = status >= 200 && status < 300) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve({
        ok,
        status,
        json: () => Promise.resolve(body),
      } as Response),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseRepoRef', () => {
  it('accepts what a person actually has in their clipboard', () => {
    // A browser URL is the common case; insisting on owner/name would be a worse product
    // for no gain.
    for (const input of [
      'facebook/react',
      '  facebook/react  ',
      'https://github.com/facebook/react',
      'http://www.github.com/facebook/react',
      'https://github.com/facebook/react.git',
      'https://github.com/facebook/react/tree/main/packages',
      // GitHub's own copy-link button produces this one, which makes it the most likely
      // paste of the lot. It used to be rejected outright.
      'https://github.com/facebook/react?tab=readme-ov-file',
      'https://github.com/facebook/react#readme',
      'https://github.com/facebook/react/',
      // No scheme, which is what a copy out of the address bar can look like.
      'github.com/facebook/react',
    ]) {
      expect(parseRepoRef(input), input).toStrictEqual({ owner: 'facebook', name: 'react' });
    }
  });

  it('will not read a hostname as an owner', () => {
    // The worst failure available here, because it does not look like one: `gitlab.com/a/b`
    // parsing as owner `gitlab.com` sends a request that can only 404, and the visitor is
    // told their repository does not exist. An owner is alphanumeric and hyphens — GitHub's
    // own rule for account names — so a host can never pass for one.
    for (const input of [
      'https://gitlab.com/vuejs/core',
      'gitlab.com/vuejs/core',
      'bitbucket.org/vuejs/core',
      'example.com/a/b',
    ]) {
      expect(parseRepoRef(input), input).toBeUndefined();
    }
  });

  it('keeps dots in a repository name, which GitHub allows', () => {
    expect(parseRepoRef('vercel/next.js')).toStrictEqual({ owner: 'vercel', name: 'next.js' });
    expect(parseRepoRef('https://github.com/vercel/next.js')).toStrictEqual({
      owner: 'vercel',
      name: 'next.js',
    });
  });

  it('carries an explicit ref through', () => {
    expect(parseRepoRef('vuejs/core@v3.4.0')).toStrictEqual({
      owner: 'vuejs',
      name: 'core',
      ref: 'v3.4.0',
    });
  });

  it('rejects rather than guesses', () => {
    // Anything that does not reduce to two path segments is refused. Guessing would send a
    // request that can only 404, and blame the repository for it.
    for (const input of ['', '   ', 'react', '/', 'https://gitlab.com/a/b', 'a b/c', 'a/b c']) {
      expect(parseRepoRef(input), JSON.stringify(input)).toBeUndefined();
    }
  });
});

describe('fetchFeatures', () => {
  const repo = { owner: 'facebook', name: 'react' };

  it('returns the document when the server sends one', async () => {
    respond(200, reactFeatures);
    await expect(fetchFeatures(repo)).resolves.toStrictEqual(reactFeatures);
  });

  it('surfaces the server’s own sentence, not a status code', async () => {
    // apps/api writes messages for a person looking at a repository that did not play. The
    // client's job is to not throw them away.
    respond(422, { error: 'this repository has no files in a language Codetta can read.' });

    await expect(fetchFeatures(repo)).rejects.toThrow(/no files in a language/);
  });

  it('marks server-side failures retryable and the visitor’s not', async () => {
    respond(504, { error: 'took too long' });
    await expect(fetchFeatures(repo)).rejects.toMatchObject({ status: 504, retryable: true });

    respond(404, { error: 'no repository' });
    await expect(fetchFeatures(repo)).rejects.toMatchObject({ status: 404, retryable: false });

    respond(422, { error: 'unsupported' });
    await expect(fetchFeatures(repo)).rejects.toMatchObject({ status: 422, retryable: false });
  });

  it('survives an error body that is not the JSON it expects', async () => {
    // A proxy or a crash produces HTML. Showing a visitor a fragment of someone's error
    // page is worse than a plain sentence.
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 502,
          json: () => Promise.reject(new SyntaxError('Unexpected token <')),
        } as unknown as Response),
      ),
    );

    await expect(fetchFeatures(repo)).rejects.toThrow(/502/);
  });

  it('reports an unreachable service as its own thing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );

    await expect(fetchFeatures(repo)).rejects.toMatchObject({ status: 0 });
    await expect(fetchFeatures(repo)).rejects.toThrow(/API running/);
  });

  it('refuses a body that is not a RepoFeatures document', async () => {
    // Annotating a fetch result is a promise, not a check. Without this the mismatch
    // surfaces as an undefined read somewhere inside the music generator instead.
    respond(200, { schemaVersion: 1, repo: { owner: 'a' } });
    await expect(fetchFeatures(repo)).rejects.toThrow(/does not understand/);

    respond(200, { ...reactFeatures, schemaVersion: 99 });
    await expect(fetchFeatures(repo)).rejects.toThrow(/does not understand/);
  });

  it('lets an abort through instead of dressing it up as a failure', async () => {
    // An abort means another repository was asked for. Reporting it would put an error on
    // screen describing a request nobody is waiting for any more.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new DOMException('aborted', 'AbortError'))),
    );

    await expect(fetchFeatures(repo)).rejects.toBeInstanceOf(DOMException);
    await expect(fetchFeatures(repo)).rejects.not.toBeInstanceOf(ApiError);
  });
});
