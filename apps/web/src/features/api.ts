import { REPO_FEATURES_KEYS, type RepoFeatures } from '@codetta/schema';

/**
 * The client for the one endpoint apps/api serves.
 *
 * The browser never talks to GitHub — docs/features-schema.md is explicit, and it is why
 * there is a service at all: the token lives in `apps/api` and never crosses the wire.
 */

/**
 * Relative by default, so a deployment behind one origin needs no configuration and the Vite
 * dev proxy can forward to :8080 without the app knowing. `VITE_API_URL` overrides it for a
 * frontend served from somewhere else, which is what the API's open CORS is for.
 */
const BASE = (import.meta.env['VITE_API_URL'] ?? '/api').replace(/\/$/, '');

/** A repository reference the API can be asked about. */
export interface RepoRef {
  owner: string;
  name: string;
  ref?: string;
}

/**
 * Everything a caller needs to tell a visitor what happened.
 *
 * `status` is kept because the four the API defines mean genuinely different things and a
 * caller may want to distinguish them — 404 and 422 are the visitor's to act on by choosing
 * another repository, 503 and 504 are ours and worth retrying.
 */
export class ApiError extends Error {
  readonly status: number;
  /** True when trying the same repository again might work. */
  readonly retryable: boolean;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.retryable = status === 503 || status === 504 || status >= 500;
  }
}

/**
 * Parses `owner/name`, with an optional `@ref` and tolerance for a pasted GitHub URL.
 *
 * Tolerant on purpose: the thing a person has in their clipboard is a browser URL, and
 * refusing it to insist on `owner/name` is a worse product for no gain. It is not a URL
 * parser — anything that does not reduce to two path segments is rejected rather than
 * guessed at.
 */
export function parseRepoRef(input: string): RepoRef | undefined {
  let text = input.trim();
  if (!text) return undefined;

  text = text
    .replace(/^https?:\/\//i, '')
    .replace(/^(www\.)?github\.com\//i, '')
    // The query string is the one that matters most: GitHub's own copy-link button produces
    // `?tab=readme-ov-file`, and keeping it made the repository name unmatchable, so the
    // most ordinary paste there is came back as "that does not look like a repository".
    .replace(/[?#].*$/, '')
    .replace(/\.git$/i, '');

  const [path, ref] = text.split('@');
  const segments = (path ?? '')
    .split('/')
    .filter(Boolean)
    // A pasted deep link carries /tree/main or /blob/…; the first two segments are the repo.
    .slice(0, 2);

  if (segments.length !== 2) return undefined;
  const [owner, name] = segments;
  if (!owner || !name) return undefined;

  // An owner is alphanumeric and hyphens — GitHub's own rule for account names, which allows
  // neither dots nor underscores. Being exact here is what stops a host from being read as an
  // owner: `github.com/a/b` without a scheme, or any other forge's URL, would otherwise parse
  // as owner `github.com` and send a request that can only 404, blaming the repository for it.
  // A repository name is looser and may contain dots.
  if (!/^[A-Za-z0-9-]+$/.test(owner) || !/^[\w.-]+$/.test(name)) return undefined;

  return ref ? { owner, name, ref } : { owner, name };
}

/**
 * GitHub's own rule for an account name, and the same one apps/api enforces before the name
 * reaches a query string.
 */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

/** Parses a bare username, with the same tolerance for a pasted profile URL. */
export function parseLogin(input: string): string | undefined {
  const text = input
    .trim()
    .replace(/^@/, '')
    .replace(/^https?:\/\//i, '')
    .replace(/^(www\.)?github\.com\//i, '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '');

  return LOGIN.test(text) ? text : undefined;
}

/** What a visitor typed, once. */
export type Target = { kind: 'repo'; repo: RepoRef } | { kind: 'user'; login: string };

/**
 * One box, two things it might hold.
 *
 * Two boxes was the obvious alternative and it asks the visitor to classify their own input
 * before they have typed it, which is a question they should never be shown: `owner/repo` and
 * `owner` are unambiguous, so the box can simply tell.
 *
 * A repository first, because it is the stricter shape — anything with two segments cannot be
 * a username, and anything with one cannot be a repository.
 */
export function parseTarget(input: string): Target | undefined {
  const repo = parseRepoRef(input);
  if (repo) return { kind: 'repo', repo };

  const login = parseLogin(input);
  return login ? { kind: 'user', login } : undefined;
}

async function messageFrom(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (body && typeof body === 'object' && 'error' in body) {
      const { error } = body as { error: unknown };
      if (typeof error === 'string' && error) return error;
    }
  } catch {
    // A proxy or a crash can produce HTML, or nothing at all. Falling through to the generic
    // sentence is better than showing a visitor a fragment of someone's error page.
  }
  return `The server responded with ${response.status}.`;
}

/**
 * Narrows the parsed body to a document apps/web can actually use.
 *
 * The type annotation on a `fetch` result is a promise, not a check — `unknown` cast to
 * RepoFeatures is still whatever the network sent. Checking the top-level keys is cheap and
 * turns a schema mismatch into one clear message here rather than into an undefined read
 * somewhere inside the music generator, which is where it would otherwise surface.
 */
function isRepoFeatures(value: unknown): value is RepoFeatures {
  if (!value || typeof value !== 'object') return false;
  const document = value as Record<string, unknown>;
  if (document['schemaVersion'] !== 1) return false;
  return REPO_FEATURES_KEYS.every((key) => key in document);
}

export async function fetchFeatures(
  repo: RepoRef,
  signal?: AbortSignal,
): Promise<RepoFeatures> {
  const path = `${BASE}/v1/features/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
  const query = repo.ref ? `?ref=${encodeURIComponent(repo.ref)}` : '';

  let response: Response;
  try {
    response = await fetch(path + query, {
      signal: signal ?? null,
      headers: { Accept: 'application/json' },
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    // No status at all: the service is not running, or the network is gone. Status 0 keeps
    // the shape uniform for callers without pretending to know which.
    throw new ApiError('Could not reach Codetta. Is the API running?', 0);
  }

  if (!response.ok) {
    throw new ApiError(await messageFrom(response), response.status);
  }

  const body: unknown = await response.json();
  if (!isRepoFeatures(body)) {
    throw new ApiError(
      'The server sent something Codetta does not understand.',
      response.status,
    );
  }
  return body;
}
