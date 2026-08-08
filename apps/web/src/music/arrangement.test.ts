import { describe, expect, it } from 'vitest';
import { reactFeatures } from '../features/fixture';
import type { RepoFeatures } from '@codetta/schema';
import {
  LANGUAGE_SHARE_FLOOR,
  MODULE_VOICE_ORDER,
  assignVoices,
  countedLanguages,
  moduleVoiceCount,
} from './arrangement';
import { buildSkeleton } from './skeleton';

function withLanguages(shares: number[]): RepoFeatures {
  return {
    ...reactFeatures,
    languages: shares.map((share, i) => ({ name: `L${i}`, share, files: 10 })),
  };
}

function withModules(count: number): RepoFeatures {
  return { ...reactFeatures, modules: reactFeatures.modules.slice(0, count) };
}

describe('countedLanguages', () => {
  it('ignores languages below the share floor', () => {
    // One stray file in a JavaScript repo must not buy a whole voice.
    expect(countedLanguages(withLanguages([0.98, 0.02]))).toBe(1);
    expect(countedLanguages(withLanguages([0.8, 0.15, 0.05]))).toBe(3);
  });

  it('counts a language sitting exactly on the floor', () => {
    expect(countedLanguages(withLanguages([0.95, LANGUAGE_SHARE_FLOOR]))).toBe(2);
  });

  it('never reports zero', () => {
    expect(countedLanguages(withLanguages([0.01, 0.01]))).toBe(1);
    expect(countedLanguages(withLanguages([]))).toBe(1);
  });
});

describe('moduleVoiceCount', () => {
  it('follows the table in docs/music-mapping.md', () => {
    expect(moduleVoiceCount(withLanguages([1]))).toBe(4);
    expect(moduleVoiceCount(withLanguages([0.6, 0.4]))).toBe(5);
    expect(moduleVoiceCount(withLanguages([0.5, 0.3, 0.2]))).toBe(5);
    expect(moduleVoiceCount(withLanguages([0.4, 0.3, 0.2, 0.1]))).toBe(6);
    expect(moduleVoiceCount(withLanguages([0.3, 0.3, 0.2, 0.1, 0.1]))).toBe(6);
  });

  it('never asks for more voices than there are modules', () => {
    // A two-module repo getting two voices is a correct outcome, not a degraded one.
    expect(
      moduleVoiceCount({ ...withLanguages([0.4, 0.3, 0.2, 0.1]), ...withModules(2) }),
    ).toBe(2);
    expect(moduleVoiceCount(withModules(1))).toBe(1);
  });
});

describe('assignVoices', () => {
  const skeleton = buildSkeleton(reactFeatures);

  it('ranks by module size, never by name', () => {
    const contexts = assignVoices(reactFeatures, skeleton);
    const shares = contexts.map((context) => context.module.share);
    expect(shares).toStrictEqual([...shares].sort((a, b) => b - a));
    expect(contexts[0]?.module.path).toBe('packages/react-dom');
  });

  it('hands the largest module the most prominent voice', () => {
    const contexts = assignVoices(reactFeatures, skeleton);
    expect(contexts[0]?.voice).toBe('lead');
    expect(contexts[0]?.rank).toBe(1);
  });

  it('fills voices in rank order and stops', () => {
    const contexts = assignVoices(reactFeatures, skeleton);
    expect(contexts.map((context) => context.voice)).toStrictEqual(
      MODULE_VOICE_ORDER.slice(0, contexts.length),
    );
  });

  it('never assigns pad or bass', () => {
    // They are the safety net. Nothing about the repo may switch them off or drive them.
    const voices: string[] = assignVoices(reactFeatures, skeleton).map((c) => c.voice);
    expect(voices).not.toContain('pad');
    expect(voices).not.toContain('bass');
  });
});
