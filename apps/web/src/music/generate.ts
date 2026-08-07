import type { RepoFeatures } from '../features/types';
import { assignVoices } from './arrangement';
import { mixdown } from './mixdown';
import {
  assertValidScore,
  barToTick,
  type NoteEvent,
  type Score,
  type VoiceId,
  type VoiceTimbre,
} from './score';
import { buildSkeleton, scoreFrom } from './skeleton';
import { arpEvents } from './voices/arp';
import { bassEvents } from './voices/bass';
import { bellEvents } from './voices/bell';
import { leadEvents } from './voices/lead';
import { padEvents } from './voices/pad';
import { textureEvents, textureTimbre } from './voices/texture';

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
  const timbre: Partial<Record<VoiceId, VoiceTimbre>> = {};

  for (const context of assignVoices(features, skeleton)) {
    if (context.voice === 'lead') events.push(...leadEvents(context));
    if (context.voice === 'arp') events.push(...arpEvents(context));
    if (context.voice === 'bell') events.push(...bellEvents(context));
    if (context.voice === 'texture') {
      events.push(...textureEvents(context));
      timbre.texture = textureTimbre(context);
    }
    // Percussion is still to come.
  }

  // Voices are written independently, so nothing before this point can see a collision.
  const score = scoreFrom(skeleton, mixdown(events, barToTick(skeleton.bars)), timbre);

  // Cheap, and it means a violation surfaces here rather than as a click in the render.
  assertValidScore(score);
  return score;
}
