import { TICKS_PER_BAR, TICKS_PER_BEAT } from './score';
import type { RepoFeatures, RepoModule, TimelineEntry } from '../features/types';
import type { Skeleton } from './skeleton';

/**
 * Every foreground voice breathes on the same grid: two-bar phrases, the last half bar
 * silent. Shared rather than per-voice on purpose — if the arp kept running through the
 * lead's rest it would fill the air the rest exists to create, and neither voice would
 * sound like it was phrasing at all.
 */
export const PHRASE_BARS = 2;
export const PHRASE_TICKS = TICKS_PER_BAR * PHRASE_BARS;
export const PHRASE_REST_TICKS = TICKS_PER_BEAT * 2;
export const PHRASE_ACTIVE_TICKS = PHRASE_TICKS - PHRASE_REST_TICKS;

/**
 * Layer 3 of docs/music-mapping.md: which voices are active, and which module drives each.
 *
 * Pad and bass are deliberately absent. They are the safety net and are always present, so
 * nothing here can switch them off or hand them a feature.
 */

/**
 * A language only counts toward diversity at this share or above. Without the floor a
 * single stray .py file in a five-thousand-file JavaScript repo would add a whole voice.
 */
export const LANGUAGE_SHARE_FLOOR = 0.05;

/** Ranks 1..6 of the Layer 2 table, in order. Percussion is included; pad and bass are not. */
export const MODULE_VOICE_ORDER = ['lead', 'arp', 'bell', 'texture', 'kick', 'hat'] as const;

export type ModuleVoiceId = (typeof MODULE_VOICE_ORDER)[number];

export function countedLanguages(features: RepoFeatures): number {
  const counted = features.languages.filter(
    (language) => language.share >= LANGUAGE_SHARE_FLOOR,
  ).length;
  // If everything falls below the floor the repo is still written in something.
  return Math.max(counted, 1);
}

/**
 * The voice-count table from docs/music-mapping.md, capped by how many modules exist.
 *
 * A two-module repo gets two voices over pad and bass. That is a correct outcome rather
 * than a degraded one — a small repo should sound small.
 */
export function moduleVoiceCount(features: RepoFeatures): number {
  const languages = countedLanguages(features);
  const byDiversity = languages <= 1 ? 4 : languages >= 4 ? 6 : 5;
  return Math.min(byDiversity, features.modules.length, MODULE_VOICE_ORDER.length);
}

export interface VoiceContext {
  voice: ModuleVoiceId;
  /** 1-based. Rank 1 is the largest module and the most prominent voice. */
  rank: number;
  module: RepoModule;
  skeleton: Skeleton;
  /** Walked in a stable order and mapped onto bars, so pitch choices follow the repo. */
  timeline: readonly TimelineEntry[];
}

/**
 * Modules arrive ordered by share descending, so rank follows size directly — never a
 * name hash. The largest module is always the most prominent voice.
 */
export function assignVoices(features: RepoFeatures, skeleton: Skeleton): VoiceContext[] {
  const count = moduleVoiceCount(features);
  const contexts: VoiceContext[] = [];

  for (let rank = 1; rank <= count; rank++) {
    const voice = MODULE_VOICE_ORDER[rank - 1];
    const module = features.modules[rank - 1];
    if (!voice || !module) break;
    contexts.push({ voice, rank, module, skeleton, timeline: features.timeline });
  }

  return contexts;
}
