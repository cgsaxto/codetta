import { describe, expect, it } from 'vitest';
import { reactFeatures } from '../../features/fixture';
import type { RepoModule } from '@codetta/schema';
import {
  PHRASE_ACTIVE_TICKS,
  PHRASE_TICKS,
  assignVoices,
  type VoiceContext,
} from '../arrangement';
import { TICKS_PER_BAR, VOICE_REGISTERS, barToTick } from '../score';
import { buildSkeleton, chordLoop } from '../skeleton';
import { arpEvents } from './arp';
import { leadEvents } from './lead';

const skeleton = buildSkeleton(reactFeatures);

function arpContext(overrides: Partial<RepoModule> = {}): VoiceContext {
  const base = assignVoices(reactFeatures, skeleton).find((c) => c.voice === 'arp');
  if (!base) throw new Error('react fixture does not reach the arp voice');
  return { ...base, module: { ...base.module, ...overrides } };
}

describe('arp', () => {
  it('stays inside the arp register', () => {
    const [lo, hi] = VOICE_REGISTERS.arp;
    for (const event of arpEvents(arpContext())) {
      expect(event.midi).toBeGreaterThanOrEqual(lo);
      expect(event.midi).toBeLessThanOrEqual(hi);
    }
  });

  it('only ever sounds tones of the bar it is in', () => {
    // It runs the chord rather than choosing pitches, which is what keeps it out of the
    // lead's way — two tunes at once is one too many.
    const chords = chordLoop(skeleton);
    for (const event of arpEvents(arpContext())) {
      const bar = Math.floor(event.tick / TICKS_PER_BAR);
      const chord = chords[bar % chords.length];
      const chordClasses = new Set(chord?.midi.map((midi) => ((midi % 12) + 12) % 12));
      expect(chordClasses, `tick ${event.tick}`).toContain(((event.midi % 12) + 12) % 12);
    }
  });

  it('restarts its figure on every bar', () => {
    // So the chord change is audible in the figure rather than smeared across it.
    const events = arpEvents(arpContext());
    const shapeIn = (bar: number) => {
      const inBar = events.filter(
        (e) => e.tick >= barToTick(bar) && e.tick < barToTick(bar + 1),
      );
      const pitches = inBar.map((e) => e.midi);
      return pitches.slice(1).map((midi, i) => Math.sign(midi - (pitches[i] ?? midi)));
    };
    // Compared across phrases, not within one: the second bar of every phrase is cut short
    // by the rest, so it holds half the figure by design.
    expect(shapeIn(2)).toStrictEqual(shapeIn(0));
    expect(shapeIn(3)).toStrictEqual(shapeIn(1));
  });

  it('gives the second bar of a phrase less of the figure, not a different one', () => {
    const events = arpEvents(arpContext());
    const pitchesIn = (bar: number) =>
      events
        .filter((e) => e.tick >= barToTick(bar) && e.tick < barToTick(bar + 1))
        .map((e) => e.midi);
    expect(pitchesIn(1).length).toBeLessThan(pitchesIn(0).length);
  });

  it('breathes on the same grid as the lead', () => {
    // Shared phrasing, not per-voice. An arp running through the lead's rest fills the air
    // the rest exists to create, and then neither voice sounds like it is phrasing.
    const arp = arpEvents(arpContext());
    const lead = leadEvents(arpContext());

    for (const event of [...arp, ...lead]) {
      const position = event.tick % PHRASE_TICKS;
      expect(position, `tick ${event.tick}`).toBeLessThan(PHRASE_ACTIVE_TICKS);
      expect(position + event.durationTicks, `tick ${event.tick}`).toBeLessThanOrEqual(
        PHRASE_ACTIVE_TICKS,
      );
    }
  });

  it('is one line, with each note ending where the next begins', () => {
    const events = arpEvents(arpContext());
    for (let i = 1; i < events.length; i++) {
      const previous = events[i - 1];
      const current = events[i];
      if (!previous || !current) continue;
      expect(previous.tick + previous.durationTicks).toBeLessThanOrEqual(current.tick);
    }
  });

  it('runs faster on a busier module', () => {
    const spacing = (density: number) => {
      const events = arpEvents(arpContext({ cyclomaticDensity: density }));
      return (events[1]?.tick ?? 0) - (events[0]?.tick ?? 0);
    };
    expect(spacing(0.15)).toBeGreaterThan(spacing(0.75));
  });

  it('sits below the lead at the same module size', () => {
    const arp = arpEvents(arpContext({ share: 0.3 }))[0]?.velocity ?? 0;
    const lead = leadEvents(arpContext({ share: 0.3 }))[0]?.velocity ?? 0;
    expect(arp).toBeLessThan(lead);
  });

  it('does not read nesting depth', () => {
    // Its register is a single octave, so the Layer 3 octave mapping has nothing to select
    // from. Reading the feature anyway would be inventing a meaning the spec does not give.
    expect(arpEvents(arpContext({ avgNestingDepth: 1 }))).toStrictEqual(
      arpEvents(arpContext({ avgNestingDepth: 9 })),
    );
  });

  it('is deterministic', () => {
    expect(arpEvents(arpContext())).toStrictEqual(arpEvents(arpContext()));
  });
});
