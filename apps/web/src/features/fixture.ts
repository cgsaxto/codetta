import raw from '@fixtures/react.json';
import type { RepoFeatures } from '@codetta/schema';

/**
 * An annotated assignment rather than a cast, deliberately: this makes `pnpm typecheck`
 * fail if the fixture stops matching the schema. A cast would hide that.
 *
 * The fixture is a real document now — `apps/api`'s output for facebook/react at
 * 20425723, produced by `cmd/fetch`. It replaced a hand-authored one that had been written
 * by eyeballing the repository, and whose feature values turned out to be an order of
 * magnitude away from anything a parser reports. See music/calibration.ts.
 */
export const reactFeatures: RepoFeatures = raw;
