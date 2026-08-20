import { parseRepoRef, type RepoRef } from './api';

/**
 * The one address this app has besides its front page: `/r/{owner}/{name}`.
 *
 * Hand-rolled rather than routed. There are two paths, one of which is "/", and a router
 * would be a dependency, a provider and a mental model in exchange for the fifteen lines
 * below. If a third address ever arrives that is a different judgement.
 *
 * The gallery never leaves the screen, so playing a repository is not navigation — the URL
 * is a label for what is sounding, not a place the visitor went. That is why App replaces
 * the history entry rather than pushing one: eight tiles sampled in a row would otherwise
 * leave eight entries behind, and pressing back eight times to escape a page you never left
 * is the worst kind of surprise.
 */

const PREFIX = '/r/';

/** The repository a path names, or undefined for anything else — including the front page. */
export function repoFromPath(pathname: string): RepoRef | undefined {
  if (!pathname.startsWith(PREFIX)) return undefined;

  // Through the same parser the input box uses, so an address and a pasted URL cannot
  // disagree about what a valid owner looks like. A hostname is not one.
  return parseRepoRef(pathname.slice(PREFIX.length));
}

export function pathForRepo(owner: string, name: string): string {
  return `${PREFIX}${owner}/${name}`;
}
