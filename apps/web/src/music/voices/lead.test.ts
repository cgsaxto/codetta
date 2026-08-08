import { describe, expect, it } from 'vitest';
import { reactFeatures } from '../../features/fixture';
import type { RepoModule } from '@codetta/schema';
import { assignVoices, type VoiceContext } from '../arrangement';
import { MODES, ROOT_PITCH_CLASS } from '../progressions';
import {
  TICKS_PER_BAR,
  TICKS_PER_BEAT,
  VOICE_REGISTERS,
  barToTick,
  type NoteEvent,
} from '../score';
import { buildSkeleton } from '../skeleton';
import { leadEvents } from './lead';

const skeleton = buildSkeleton(reactFeatures);

function leadContext(overrides: Partial<RepoModule> = {}): VoiceContext {
  const [base] = assignVoices(reactFeatures, skeleton);
  if (!base) throw new Error('react fixture has no modules');
  return { ...base, module: { ...base.module, ...overrides } };
}

const PHRASE = 32;

function pitchesOf(events: readonly NoteEvent[], phrase: number): number[] {
  return events
    .filter((e) => e.tick >= phrase * PHRASE && e.tick < (phrase + 1) * PHRASE)
    .map((e) => e.midi);
}

/**
 * The motif's contour, as the direction of each interval. Compared by direction rather than
 * by semitones because a diatonic transposition keeps the shape while changing the interval
 * sizes — a third from the tonic and a third from the second are four and three semitones.
 */
function shapeOf(events: readonly NoteEvent[], phrase: number): number[] {
  const pitches = pitchesOf(events, phrase);
  return pitches.slice(1).map((midi, i) => Math.sign(midi - (pitches[i] ?? midi)));
}

describe('lead', () => {
  it('stays inside the lead register', () => {
    const [lo, hi] = VOICE_REGISTERS.lead;
    for (const event of leadEvents(leadContext())) {
      expect(event.midi).toBeGreaterThanOrEqual(lo);
      expect(event.midi).toBeLessThanOrEqual(hi);
    }
  });

  it('only ever sounds notes of the active scale', () => {
    const tonic = ROOT_PITCH_CLASS[skeleton.root];
    const inScale = new Set(MODES[skeleton.mode].map((offset) => (tonic + offset) % 12));
    for (const event of leadEvents(leadContext())) {
      expect(inScale, `midi ${event.midi}`).toContain(((event.midi % 12) + 12) % 12);
    }
  });

  it('is monophonic', () => {
    // One line, not a chord. The register overlaps the pad, so overlapping notes here
    // would be the fastest route back to mud.
    const events = leadEvents(leadContext());
    for (let i = 1; i < events.length; i++) {
      const previous = events[i - 1];
      const current = events[i];
      if (!previous || !current) continue;
      expect(previous.tick + previous.durationTicks).toBeLessThanOrEqual(current.tick);
    }
  });

  it('is deterministic', () => {
    expect(leadEvents(leadContext())).toStrictEqual(leadEvents(leadContext()));
  });

  it('restates its motif instead of inventing new notes', () => {
    // The property that turns pitches into a tune. Forty bars of freshly chosen notes are a
    // random walk over the scale even when every interval is stepwise and every pitch is in
    // key, because a listener has nothing to hold on to.
    const events = leadEvents(leadContext());
    expect(shapeOf(events, 0)).toStrictEqual(shapeOf(events, 1));
    expect(shapeOf(events, 0)).toStrictEqual(shapeOf(events, 3));
    // Re-anchored to the bar's chord, so the same shape is not the same notes.
    expect(pitchesOf(events, 0)).not.toStrictEqual(pitchesOf(events, 1));
  });

  it('answers with a contrasting phrase', () => {
    // AABA. Without the B the loop is one idea repeated until it wears out.
    const events = leadEvents(leadContext());
    expect(shapeOf(events, 2)).not.toStrictEqual(shapeOf(events, 0));
  });

  it('keeps the same rhythm in every phrase', () => {
    const events = leadEvents(leadContext());
    const onsets = (phrase: number) =>
      events
        .filter((e) => e.tick >= phrase * 32 && e.tick < (phrase + 1) * 32)
        .map((e) => e.tick - phrase * 32);
    expect(onsets(1)).toStrictEqual(onsets(0));
    expect(onsets(2)).toStrictEqual(onsets(0));
  });

  it('never leaps further than a fifth', () => {
    const events = leadEvents(leadContext());
    for (let i = 1; i < events.length; i++) {
      const previous = events[i - 1];
      const current = events[i];
      if (!previous || !current) continue;
      expect(Math.abs(current.midi - previous.midi), `note ${i}`).toBeLessThanOrEqual(7);
    }
  });

  it('rests at the end of every phrase', () => {
    // Two-bar phrases, the last half bar silent. A line that never stops is exhausting
    // however good the notes are.
    const phraseTicks = TICKS_PER_BAR * 2;
    const restStart = phraseTicks - TICKS_PER_BEAT * 2;
    for (const event of leadEvents(leadContext())) {
      const position = event.tick % phraseTicks;
      expect(position, `tick ${event.tick}`).toBeLessThan(restStart);
      // Notes stop at the rest rather than playing over it.
      expect(position + event.durationTicks, `tick ${event.tick}`).toBeLessThanOrEqual(
        restStart,
      );
    }
  });

  it('stays near the register its module asked for', () => {
    // Without the tether a random walk drifts and avgNestingDepth would only decide where
    // the first note landed.
    const events = leadEvents(leadContext({ avgNestingDepth: 1 }));
    const average = events.reduce((sum, event) => sum + event.midi, 0) / events.length;
    const [lo, hi] = VOICE_REGISTERS.lead;
    expect(average).toBeLessThan(lo + (hi - lo) / 2);
  });

  it('takes note length from average function length', () => {
    const short = leadEvents(leadContext({ avgFunctionLength: 4 }))[0]?.durationTicks;
    const medium = leadEvents(leadContext({ avgFunctionLength: 16 }))[0]?.durationTicks;
    const long = leadEvents(leadContext({ avgFunctionLength: 40 }))[0]?.durationTicks;
    expect(short).toBe(1);
    expect(medium).toBe(2);
    expect(long).toBe(8);
  });

  it('takes register from nesting depth, deeper being higher', () => {
    const average = (depth: number) => {
      const events = leadEvents(leadContext({ avgNestingDepth: depth }));
      return events.reduce((sum, event) => sum + event.midi, 0) / events.length;
    };
    expect(average(1)).toBeLessThan(average(5));
  });

  it('takes density from cyclomatic density, and never fills every slot', () => {
    const count = (density: number) =>
      leadEvents(leadContext({ cyclomaticDensity: density })).length;

    expect(count(0.1)).toBeLessThan(count(0.6));

    // Clamped at 0.75, and notes are at least a 16th long, so a wall of sound is
    // unreachable however extreme the repo is.
    const slots = barToTick(skeleton.bars);
    expect(count(1)).toBeLessThan(slots);
    // The floor keeps the loudest voice from vanishing on a repo with no branching at all.
    expect(count(0)).toBeGreaterThan(0);
  });

  it('takes velocity from module share, bigger being louder', () => {
    const velocity = (share: number) => leadEvents(leadContext({ share }))[0]?.velocity ?? 0;
    expect(velocity(0.05)).toBeLessThan(velocity(0.45));
    expect(velocity(0.9)).toBeLessThanOrEqual(0.8);
  });

  it('never runs past the end of the piece', () => {
    const totalTicks = barToTick(skeleton.bars);
    for (const event of leadEvents(leadContext({ avgFunctionLength: 40 }))) {
      expect(event.tick + event.durationTicks).toBeLessThanOrEqual(totalTicks);
    }
  });

  it('gives a file the same pitch wherever the surrounding draws change', () => {
    // Pitch is hashed from the timeline entry, not drawn from the stream, so it survives
    // an unrelated change in how many random numbers get consumed elsewhere.
    const base = leadEvents(leadContext());
    const shifted = leadEvents({ ...leadContext(), timeline: reactFeatures.timeline });
    expect(base.map((event) => event.midi)).toStrictEqual(shifted.map((event) => event.midi));
  });
});
