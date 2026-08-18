import type { RepoFeatures } from '@codetta/schema';

/**
 * The pre-rendered gallery: eight repositories, two per supported language.
 *
 * Committed documents rather than API calls, and that is not only about speed. Two of these
 * cannot come through the service at all — kubernetes takes 35 seconds to fetch and parse and
 * vscode 77, against a 25-second budget that docs/features-schema.md calls non-negotiable. A
 * front page whose tiles are the largest repositories anyone would name has to be built ahead
 * of time or not built at all.
 *
 * It also means the gallery works with the backend down, which for a landing page is the
 * difference between a bad day and an empty screen.
 */
const documents = import.meta.glob<{ default: RepoFeatures }>(
  '../../../../fixtures/gallery/*.json',
  { eager: true },
);

/**
 * Ordered by name so the tiles do not rearrange between builds. Curation of which eight, and
 * in what order a visitor should meet them, is a question for the landing page rather than
 * for the loader.
 */
export const GALLERY: readonly RepoFeatures[] = Object.keys(documents)
  .sort()
  .map((path) => documents[path]!.default);
