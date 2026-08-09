import reactRaw from '@fixtures/react.json';
import requestsRaw from '@fixtures/requests.json';
import type { RepoFeatures } from '@codetta/schema';

/**
 * Annotated assignments rather than casts, deliberately: this makes `pnpm typecheck` fail if
 * a fixture stops matching the schema. A cast would hide that.
 *
 * Both are real documents, produced by `apps/api`'s cmd/fetch. They replaced a single
 * hand-authored one that had been written by eyeballing a repository and whose feature
 * values turned out to be an order of magnitude away from anything a parser reports.
 */
export const reactFeatures: RepoFeatures = reactRaw;
export const requestsFeatures: RepoFeatures = requestsRaw;

/**
 * Two, and these two, because one fixture cannot show that a mapping discriminates.
 *
 * They sit at opposite ends of the calibration in music/calibration.ts. react's largest
 * module is DOM plumbing and scores 0.05 nesting and 0.11 branching; requests' is the
 * library itself at 0.88 and 0.85. Everything Layer 3 decides — octave, note length, rhythm
 * — is different between them, which is the only way to hear whether it decides anything.
 *
 * That split is not a coincidence of these two repositories. JavaScript and TypeScript
 * repositories land low across the whole calibration set and Python and Go land high; see
 * @docs/roadmap.md, where it is an open question rather than a settled one.
 */
export const FIXTURES = {
  react: reactFeatures,
  requests: requestsFeatures,
} as const satisfies Record<string, RepoFeatures>;

export type FixtureName = keyof typeof FIXTURES;
