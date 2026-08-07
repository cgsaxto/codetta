import type { RepoFeatures } from '../features/types';
import { assignVoices } from './arrangement';
import { assertValidScore, type NoteEvent, type Score } from './score';
import { buildSkeleton, scoreFrom } from './skeleton';
import { bassEvents } from './voices/bass';
import { leadEvents } from './voices/lead';
import { padEvents } from './voices/pad';

/**
 * The whole generation path, as one pure function. Same features in, same Score out,
 * forever — nothing here reads the clock or an unseeded random source.
 *
 * Pad and bass are unconditional: they are the safety net, and they read no feature. Every
 * other voice is driven by a module, and how many of them play comes from the language
 * diversity table in docs/music-mapping.md.
 */
export function generateScore(features: RepoFeatures): Score {
  const skeleton = buildSkeleton(features);
  const events: NoteEvent[] = [...padEvents(skeleton), ...bassEvents(skeleton)];

  for (const context of assignVoices(features, skeleton)) {
    if (context.voice === 'lead') events.push(...leadEvents(context));
    // arp, bell, texture and percussion are still to come.
  }

  const score = scoreFrom(skeleton, events);

  // Cheap, and it means a violation surfaces here rather than as a click in the render.
  assertValidScore(score);
  return score;
}
