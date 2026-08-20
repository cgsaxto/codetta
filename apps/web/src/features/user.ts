import { ApiError, type RepoRef } from './api';

/**
 * The endpoint behind "type your username".
 *
 * It answers a question and does not act on it: given a login, this is the repository Codetta
 * would play and the face to put on the card. Fetching and parsing that repository is the
 * other endpoint's job, and keeping the two apart is what lets the page say "torvalds →
 * pesconvert" while the reading is still going on — one combined call would have to stay
 * silent for the fifteen seconds a large repository takes, which is exactly the moment
 * someone needs to be told that what they typed was understood.
 */

const BASE = (import.meta.env['VITE_API_URL'] ?? '/api').replace(/\/$/, '');

export interface PickedRepo extends RepoRef {
  stars: number;
  primaryLanguage: string;
}

export interface UserPick {
  /** GitHub's spelling of the login, not the visitor's. */
  login: string;
  name: string;
  /**
   * A data URI, or absent. Inlined by the API rather than linked, so the browser still never
   * talks to GitHub and so the card stays saveable — a cross-origin image taints a canvas.
   */
  avatar?: string;
  repo: PickedRepo;
  /**
   * How many more-starred repositories were passed over for their language. Said out loud on
   * the page: "your most-starred repository" and "your most-starred repository Codetta can
   * read" are different claims, and only the second one is true.
   */
  passedOver: number;
}

function isUserPick(value: unknown): value is UserPick {
  if (!value || typeof value !== 'object') return false;
  const body = value as Record<string, unknown>;
  if (typeof body['login'] !== 'string' || typeof body['passedOver'] !== 'number') return false;

  const repo = body['repo'];
  if (!repo || typeof repo !== 'object') return false;
  const picked = repo as Record<string, unknown>;
  return typeof picked['owner'] === 'string' && typeof picked['name'] === 'string';
}

async function messageFrom(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (body && typeof body === 'object' && 'error' in body) {
      const { error } = body as { error: unknown };
      if (typeof error === 'string' && error) return error;
    }
  } catch {
    // A proxy or a crash can produce HTML, or nothing at all.
  }
  return `The server responded with ${response.status}.`;
}

export async function fetchUserPick(login: string, signal?: AbortSignal): Promise<UserPick> {
  let response: Response;
  try {
    response = await fetch(`${BASE}/v1/users/${encodeURIComponent(login)}`, {
      signal: signal ?? null,
      headers: { Accept: 'application/json' },
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new ApiError('Could not reach Codetta. Is the API running?', 0);
  }

  if (!response.ok) throw new ApiError(await messageFrom(response), response.status);

  const body: unknown = await response.json();
  if (!isUserPick(body)) {
    throw new ApiError(
      'The server sent something Codetta does not understand.',
      response.status,
    );
  }
  return body;
}

/** What the page says about a pick, in one sentence. */
export function pickSummary(pick: UserPick): string {
  const stars = pick.repo.stars.toLocaleString('en-US');
  const readable = pick.passedOver > 0 ? ' Codetta can read' : '';
  return `${pick.login}'s most-starred repository${readable}: ${pick.repo.owner}/${pick.repo.name}, ${pick.repo.primaryLanguage}, ${stars} stars.`;
}
