import { describe, expect, it } from 'vitest';
import { reactFeatures } from '../../features/fixture';
import type { RepoModule } from '@codetta/schema';
import {
  PHRASE_ACTIVE_TICKS,
  PHRASE_TICKS,
  assignVoices,
  type VoiceContext,
} from '../arrangement';
import { MODES, ROOT_PITCH_CLASS } from '../progressions';
import {
  TICKS_PER_BAR,
  TICKS_PER_BEAT,
  VOICE_REGISTERS,
  barToTick,
  type NoteEvent,
} from '../score';
import { buildSkeleton } from '../skeleton';
import { TARGET_BAND, leadEvents } from './lead';

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

  it('answers with a contrasting phrase, on every rhythm in the palette', () => {
    // AABA. Without the B the loop is one idea repeated until it wears out.
    //
    // Every rhythm, because checking one repository is what let this break: B used to be an
    // independently hashed contour, which on the sparsest rhythm has a single free step and
    // therefore a coin-flip chance of landing on A's shape. The one fixture this ran against
    // happened to select the busiest rhythm, so the collapse to AAAA never showed up here.
    for (const cyclomaticDensity of [0, 0.004, 0.008, 0.012, 0.016, 0.02, 0.05, 1]) {
      const events = leadEvents(leadContext({ cyclomaticDensity }));
      expect(shapeOf(events, 2), `density ${cyclomaticDensity}`).not.toStrictEqual(
        shapeOf(events, 0),
      );
    }
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

  // The values below are real ones. Everything in this block used to be written against
  // ranges taken from a hand-authored fixture — nesting of 1 and 5, function lengths of 4
  // and 40, densities of 0.1 and 0.6 — and every one of those numbers is off the top of
  // what a parser actually reports. The tests passed and proved nothing, because the mapping
  // they were checking clamped to the same answer for every repository on earth. See
  // music/calibration.ts for where these replacements come from.

  it('stays near the target its module asked for', () => {
    // Without the tether a random walk drifts and avgNestingDepth would only decide where
    // the first note landed. Measured against the target band rather than the register,
    // because the band is deliberately narrower than the register — "in the lower half of
    // C4–C6" stopped being the same statement as "low".
    const [bandLo, bandHi] = TARGET_BAND;
    for (const [avgNestingDepth, position] of [
      [0, 0],
      [0.45, 0.5],
      [5, 1],
    ] as const) {
      const events = leadEvents(leadContext({ avgNestingDepth }));
      const average = events.reduce((sum, event) => sum + event.midi, 0) / events.length;
      const target = bandLo + (bandHi - bandLo) * position;
      expect(Math.abs(average - target), `nesting ${avgNestingDepth}`).toBeLessThan(4);
    }
  });

  it('does not park inside the pad, however flat the module', () => {
    // The mud that got reported. react's nesting is near zero, which used to put its lead at
    // 60–72 against a pad voiced 53–70: not overlapping registers, the same register, and
    // two voices sharing a register and a chord is what mud is made of. Single notes may dip
    // into the pad — the register overlaps on purpose — but the line's centre may not.
    const [, padTop] = VOICE_REGISTERS.pad;
    for (const avgNestingDepth of [0, 0.05, 0.3, 0.85, 5]) {
      const events = leadEvents(leadContext({ avgNestingDepth }));
      const average = events.reduce((sum, event) => sum + event.midi, 0) / events.length;
      expect(average, `nesting ${avgNestingDepth}`).toBeGreaterThanOrEqual(padTop);
    }
  });

  it('takes note length from average function length', () => {
    const ticks = (avgFunctionLength: number) =>
      leadEvents(leadContext({ avgFunctionLength }))[0]?.durationTicks ?? 0;

    // Monotonic across the observed p10–p90, and the ends are audibly apart. Not four
    // distinct lengths: the note length is a fraction of the gap to the next onset, and on a
    // busy rhythm that gap is a few sixteenths — a grid no palette can subdivide further.
    // Asserting four would be asserting against the grid rather than against the mapping.
    const lengths = [1, 3, 5, 7].map(ticks);
    expect(lengths).toStrictEqual([...lengths].sort((a, b) => a - b));
    expect(ticks(7)).toBeGreaterThan(ticks(1));
  });

  it('is never mostly silence, however sparse the repo', () => {
    // What "react sounds empty" was, measured. Its lead ran at a quarter of its own phrase
    // window — three sixteenths of sound in two bars — because the same axis that selects a
    // sparse rhythm also selected the shortest note length, and the two multiplied.
    //
    // The floor is on the fraction of the phrase that sounds, not on note count, because a
    // sparse line is a legitimate outcome for a flat repository and a hollow one is not.
    const active = PHRASE_ACTIVE_TICKS;

    for (const avgFunctionLength of [0, 1, 3, 5, 7, 20]) {
      for (const cyclomaticDensity of [0, 0.004, 0.01, 0.022, 1]) {
        const events = leadEvents(leadContext({ avgFunctionLength, cyclomaticDensity }));
        const sounding = events
          .filter((event) => event.tick < PHRASE_TICKS)
          .reduce((sum, event) => sum + event.durationTicks, 0);
        expect(
          sounding / active,
          `fnLength ${avgFunctionLength}, density ${cyclomaticDensity}`,
        ).toBeGreaterThan(0.4);
      }
    }
  });

  it('takes register from nesting depth, deeper being higher', () => {
    const average = (depth: number) => {
      const events = leadEvents(leadContext({ avgNestingDepth: depth }));
      return events.reduce((sum, event) => sum + event.midi, 0) / events.length;
    };
    expect(average(0.05)).toBeLessThan(average(0.85));
  });

  it('takes density from cyclomatic density, and never fills every slot', () => {
    const count = (density: number) =>
      leadEvents(leadContext({ cyclomaticDensity: density })).length;

    expect(count(0.002)).toBeLessThan(count(0.02));

    // No rhythm in the palette fires on every 16th, so a wall of sound is unreachable
    // however extreme the repo is — including well past anything yet measured.
    const slots = barToTick(skeleton.bars);
    expect(count(1)).toBeLessThan(slots);
    // The sparsest rhythm still has notes, so a repo with no branching at all keeps its
    // loudest voice rather than losing it.
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
