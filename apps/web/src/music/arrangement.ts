import { unitHash } from './rng';
import {
  TICKS_PER_BAR,
  TICKS_PER_BEAT,
  VOICE_ORDER,
  type NoteEvent,
  type Section,
  type SectionName,
  type VoiceId,
} from './score';
import type { RepoFeatures, RepoModule, TimelineEntry } from '@codetta/schema';
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

/**
 * Layer 4: which voices sound in which section.
 *
 * Applied after every voice has written its notes, for the same reason the collision rules
 * are — a voice cannot see the section it is in without every voice growing its own copy of
 * the arrangement. Voices write the whole piece; this decides what is heard.
 */
const SECTION_VOICES: Record<SectionName, ReadonlySet<VoiceId>> = {
  intro: new Set<VoiceId>(['pad', 'bass']),
  build: new Set<VoiceId>(['pad', 'bass', 'lead', 'arp']),
  peak: new Set<VoiceId>(VOICE_ORDER),
  // Layer 2 wins over the older wording here: four bars with no bass is not a breakdown,
  // it is a hole.
  break: new Set<VoiceId>(['pad', 'bass', 'lead']),
  return: new Set<VoiceId>(VOICE_ORDER),
  outro: new Set<VoiceId>(VOICE_ORDER),
};

/** Break thins the foreground. Thinning the safety net is the same mistake in another form. */
const BREAK_DENSITY = 0.4;

/** Reverse rank order, which is the order the outro sheds them in. */
const OUTRO_DROP_ORDER: readonly VoiceId[] = ['hat', 'kick', 'texture', 'bell', 'arp', 'lead'];

const SAFETY_NET: ReadonlySet<VoiceId> = new Set<VoiceId>(['pad', 'bass']);

function sectionAt(sections: readonly Section[], bar: number): Section | undefined {
  return sections.find(
    (section) => bar >= section.startBar && bar < section.startBar + section.bars,
  );
}

function soundsIn(voice: VoiceId, section: Section, bar: number): boolean {
  if (!SECTION_VOICES[section.name].has(voice)) return false;
  if (SAFETY_NET.has(voice)) return true;

  const offset = bar - section.startBar;

  // Voice 1 at the start of the build, voice 2 at its midpoint.
  if (section.name === 'build' && voice === 'arp') return offset >= section.bars / 2;

  if (section.name === 'outro') {
    const rank = OUTRO_DROP_ORDER.indexOf(voice);
    if (rank === -1) return true;
    const exitBar = Math.floor(((rank + 1) / (OUTRO_DROP_ORDER.length + 1)) * section.bars);
    return offset < exitBar;
  }

  return true;
}

/**
 * Gate and thin the finished voices according to the section template. Deterministic: the
 * thinning is hashed from the event itself, never drawn from a stream.
 */
export function applyStructure(
  events: readonly NoteEvent[],
  sections: readonly Section[],
): NoteEvent[] {
  return events.filter((event) => {
    const bar = Math.floor(event.tick / TICKS_PER_BAR);
    const section = sectionAt(sections, bar);
    if (!section) return false;
    if (!soundsIn(event.voice, section, bar)) return false;

    if (section.name === 'break' && !SAFETY_NET.has(event.voice)) {
      return unitHash(`break#${event.voice}#${event.tick}#${event.midi}`) < BREAK_DENSITY;
    }
    return true;
  });
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
