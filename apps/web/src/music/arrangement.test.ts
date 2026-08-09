import { describe, expect, it } from 'vitest';
import { reactFeatures } from '../features/fixture';
import type { RepoFeatures } from '@codetta/schema';
import {
  LANGUAGE_SHARE_FLOOR,
  MODULE_VOICE_ORDER,
  applyAccents,
  assignVoices,
  countedLanguages,
  moduleVoiceCount,
} from './arrangement';
import { TICKS_PER_BAR } from './score';
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

describe('applyAccents', () => {
  const at = (tick: number) => ({
    voice: 'lead' as const,
    tick,
    durationTicks: 2,
    midi: 72,
    velocity: 0.5,
  });

  it('stresses the bar the way 4/4 is stressed', () => {
    const [one, three, two, offbeat, sixteenth] = applyAccents([
      at(0),
      at(8),
      at(4),
      at(2),
      at(1),
    ]).map((event) => event.velocity);

    // Strictly descending: beat 1, beat 3, the other beats, offbeat eighths, sixteenths.
    expect([one, three, two, offbeat, sixteenth]).toStrictEqual(
      [one, three, two, offbeat, sixteenth].sort((a, b) => (b ?? 0) - (a ?? 0)),
    );
    expect(one).toBeGreaterThan(sixteenth ?? 0);
  });

  it('shapes the bar without reordering the voices', () => {
    // Multiplicative on purpose. A voice's own gain decides how loud it is against the
    // others; this only decides how it is shaped inside the bar, so a quiet voice on a
    // downbeat must not overtake a loud one on the same downbeat.
    const quiet = { ...at(0), voice: 'texture' as const, velocity: 0.22 };
    const loud = { ...at(0), velocity: 0.8 };
    const [shapedQuiet, shapedLoud] = applyAccents([quiet, loud]);
    expect(shapedQuiet?.velocity).toBeLessThan(shapedLoud?.velocity ?? 0);
  });

  it('repeats every bar and leaves everything but velocity alone', () => {
    for (const tick of [0, 5, 11]) {
      const [first] = applyAccents([at(tick)]);
      const [later] = applyAccents([at(tick + TICKS_PER_BAR * 7)]);
      expect(first?.velocity).toBe(later?.velocity);
    }
    const source = at(3);
    const [accented] = applyAccents([source]);
    expect({ ...accented, velocity: source.velocity }).toStrictEqual(source);
  });

  it('never pushes a velocity outside the range the validator allows', () => {
    for (let tick = 0; tick < TICKS_PER_BAR; tick++) {
      const [event] = applyAccents([{ ...at(tick), velocity: 1 }]);
      expect(event?.velocity).toBeGreaterThan(0);
      expect(event?.velocity).toBeLessThanOrEqual(1);
    }
  });
});
