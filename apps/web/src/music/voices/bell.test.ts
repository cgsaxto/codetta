import { describe, expect, it } from 'vitest';
import { reactFeatures } from '../../features/fixture';
import type { RepoModule } from '../../features/types';
import { PHRASE_TICKS, assignVoices, type VoiceContext } from '../arrangement';
import { TICKS_PER_BAR, VOICE_REGISTERS, barToTick } from '../score';
import { PROGRESSIONS } from '../progressions';
import { buildSkeleton, chordLoop, type Skeleton } from '../skeleton';
import { bellEvents } from './bell';

const skeleton = buildSkeleton(reactFeatures);

function bellContext(overrides: Partial<RepoModule> = {}): VoiceContext {
  const base = assignVoices(reactFeatures, skeleton).find((c) => c.voice === 'bell');
  if (!base) throw new Error('react fixture does not reach the bell voice');
  return { ...base, module: { ...base.module, ...overrides } };
}

describe('bell', () => {
  it('stays inside the bell register', () => {
    const [lo, hi] = VOICE_REGISTERS.bell;
    for (const event of bellEvents(bellContext())) {
      expect(event.midi).toBeGreaterThanOrEqual(lo);
      expect(event.midi).toBeLessThanOrEqual(hi);
    }
  });

  it('stays sparse however busy the module is', () => {
    // The temptation with a bell is to give it something to play, and that is exactly
    // wrong: it earns its place by being rare enough that each strike registers.
    for (const density of [0.15, 0.4, 0.75, 1]) {
      const events = bellEvents(bellContext({ cyclomaticDensity: density }));
      expect(events.length / skeleton.bars, `density ${density}`).toBeLessThanOrEqual(1);
    }
  });

  it('only ever strikes a chord tone', () => {
    // It is the most exposed voice in the mix, so a wrong note has nowhere to hide.
    const chords = chordLoop(skeleton);
    for (const event of bellEvents(bellContext())) {
      const bar = Math.floor(event.tick / TICKS_PER_BAR);
      const chord = chords[bar % chords.length];
      const chordClasses = new Set(chord?.midi.map((midi) => ((midi % 12) + 12) % 12));
      expect(chordClasses, `tick ${event.tick}`).toContain(((event.midi % 12) + 12) % 12);
    }
  });

  it('strikes a tone the next chord still holds, where the progression offers one', () => {
    // A bell rings past the bar it was struck in, so by the time it fades the harmony has
    // moved. Striking a shared tone means it is still a chord tone when that happens —
    // without it the bell reads as slightly out of tune, in the most exposed register there
    // is. react's loop shares a tone across every change, so here it should always hold.
    const chords = chordLoop(skeleton);
    for (const event of bellEvents(bellContext())) {
      const bar = Math.floor(event.tick / TICKS_PER_BAR);
      const next = chords[(bar + 1) % chords.length];
      const nextClasses = new Set(next?.midi.map((midi) => ((midi % 12) + 12) % 12));
      expect(nextClasses, `tick ${event.tick}`).toContain(((event.midi % 12) + 12) % 12);
    }
  });

  it('falls back to the current chord when no tone is shared', () => {
    // `undertow` is i–♭VII–♭VI–♭VII, and no two adjacent chords in it share a note at all.
    // There the shortened decay carries the fix instead, and the strike must still land on
    // a chord tone rather than on nothing.
    const undertow = PROGRESSIONS.find((progression) => progression.id === 'undertow');
    if (!undertow) throw new Error('undertow is missing from the progression set');

    const bare: Skeleton = { ...skeleton, root: 'A', mode: 'aeolian', progression: undertow };
    const chords = chordLoop(bare);
    const events = bellEvents({ ...bellContext(), skeleton: bare });

    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      const bar = Math.floor(event.tick / TICKS_PER_BAR);
      const chord = chords[bar % chords.length];
      const classes = new Set(chord?.midi.map((midi) => ((midi % 12) + 12) % 12));
      expect(classes, `tick ${event.tick}`).toContain(((event.midi % 12) + 12) % 12);
    }
  });

  it('places the same accents in every phrase', () => {
    const events = bellEvents(bellContext());
    const offsets = (phrase: number) =>
      events
        .filter((e) => e.tick >= phrase * PHRASE_TICKS && e.tick < (phrase + 1) * PHRASE_TICKS)
        .map((e) => e.tick - phrase * PHRASE_TICKS);
    expect(offsets(1)).toStrictEqual(offsets(0));
    expect(offsets(5)).toStrictEqual(offsets(0));
  });

  it('is the quietest pitched voice', () => {
    expect(bellEvents(bellContext())[0]?.velocity).toBeLessThan(0.6);
  });

  it('never runs past the end of the piece', () => {
    const totalTicks = barToTick(skeleton.bars);
    for (const event of bellEvents(bellContext())) {
      expect(event.tick + event.durationTicks).toBeLessThanOrEqual(totalTicks);
    }
  });

  it('is deterministic', () => {
    expect(bellEvents(bellContext())).toStrictEqual(bellEvents(bellContext()));
  });
});
