import type { RepoFeatures } from '../features/types';
import { assertValidScore, type Score } from './score';
import { buildSkeleton, scoreFrom } from './skeleton';
import { bassEvents } from './voices/bass';
import { padEvents } from './voices/pad';

/**
 * The whole generation path, as one pure function. Same features in, same Score out,
 * forever — nothing here reads the clock or an unseeded random source.
 *
 * Phase 0 currently emits pad and bass only. The roadmap gate is whether that alone is
 * pleasant on loop, because no amount of lead, arp or bell rescues a bad foundation.
 */
export function generateScore(features: RepoFeatures): Score {
  const skeleton = buildSkeleton(features);
  const score = scoreFrom(skeleton, [...padEvents(skeleton), ...bassEvents(skeleton)]);

  // Cheap, and it means a violation surfaces here rather than as a click in the render.
  assertValidScore(score);
  return score;
}
