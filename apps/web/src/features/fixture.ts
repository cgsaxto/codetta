import raw from '@fixtures/react.json';
import type { RepoFeatures } from './types';

/**
 * An annotated assignment rather than a cast, deliberately: this makes `pnpm typecheck`
 * fail if the hand-authored fixture stops matching the schema. A cast would hide that.
 */
export const reactFeatures: RepoFeatures = raw;
