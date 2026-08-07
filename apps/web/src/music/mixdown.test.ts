import { describe, expect, it } from 'vitest';
import { mixdown } from './mixdown';
import { MAX_CONCURRENT_NOTES, type NoteEvent, type VoiceId } from './score';

function note(voice: VoiceId, tick: number, midi: number, durationTicks = 4): NoteEvent {
  return { voice, tick, durationTicks, midi, velocity: 0.5 };
}

function peakPolyphony(events: readonly NoteEvent[], totalTicks: number): number {
  const active = new Array<number>(totalTicks).fill(0);
  for (const event of events) {
    for (let tick = event.tick; tick < event.tick + event.durationTicks; tick++) {
      const current = active[tick];
      if (current !== undefined) active[tick] = current + 1;
    }
  }
  return Math.max(...active, 0);
}

describe('unisons', () => {
  it('moves the later-ranked of two foreground voices', () => {
    // Two articulated lines on one pitch mask each other; the quieter simply vanishes.
    const result = mixdown([note('lead', 0, 60), note('arp', 0, 60)], 64);
    expect(result.find((event) => event.voice === 'lead')?.midi).toBe(60);
    expect(result.find((event) => event.voice === 'arp')?.midi).toBe(72);
  });

  it('leaves a foreground voice doubling the pad exactly where it is', () => {
    // A pluck speaks through a sustained pad rather than disappearing into it, and doubling
    // a pad is something arrangers do on purpose. Moving one note of a motif up an octave
    // to dodge the pad turns the phrase into a different phrase, which costs far more.
    const result = mixdown([note('pad', 0, 70), note('lead', 0, 70)], 64);
    expect(result.map((event) => event.midi)).toStrictEqual([70, 70]);
  });

  it('never moves pad or bass', () => {
    const result = mixdown([note('bass', 0, 36), note('pad', 0, 48), note('pad', 0, 36)], 64);
    expect(result.filter((e) => e.voice === 'pad').map((e) => e.midi)).toStrictEqual([36, 48]);
    expect(result.find((e) => e.voice === 'bass')?.midi).toBe(36);
  });

  it('falls back to the octave below when the one above leaves the register', () => {
    // arp is C4–C5, so a collision at C5 has nowhere to go but down.
    const result = mixdown([note('lead', 0, 72), note('arp', 0, 72)], 64);
    expect(result.find((event) => event.voice === 'arp')?.midi).toBe(60);
  });

  it('keeps the pitch rather than dropping the note when no octave fits', () => {
    // bell is C5–C6, so from the middle of it both octaves fall outside. A doubled note is
    // a smaller loss than a hole in the line.
    const result = mixdown([note('lead', 0, 78), note('bell', 0, 78)], 64);
    expect(result.find((event) => event.voice === 'bell')?.midi).toBe(78);
    expect(result).toHaveLength(2);
  });

  it('leaves notes that only share a pitch class alone', () => {
    // An octave apart is not a unison — it is a doubling, and it is often the point.
    const result = mixdown([note('lead', 0, 60), note('arp', 0, 72)], 64);
    expect(result.map((event) => event.midi)).toStrictEqual([60, 72]);
  });

  it('leaves notes that never sound together alone', () => {
    const result = mixdown([note('lead', 0, 64, 4), note('arp', 4, 64, 4)], 64);
    expect(result.map((event) => event.midi)).toStrictEqual([64, 64]);
  });

  it('ignores percussion, which has no pitch to collide with', () => {
    const result = mixdown([note('kick', 0, 36), note('bass', 0, 36)], 64);
    expect(result.find((event) => event.voice === 'kick')?.midi).toBe(36);
  });
});

describe('polyphony ceiling', () => {
  const CHORD = [60, 62, 64, 65, 67, 69, 71, 72, 74];

  it('drops nothing when the score is already under the ceiling', () => {
    const events = CHORD.slice(0, MAX_CONCURRENT_NOTES).map((midi) => note('pad', 0, midi));
    expect(mixdown(events, 64)).toHaveLength(MAX_CONCURRENT_NOTES);
  });

  it('drops from the lowest-ranked voice first', () => {
    const events = [
      note('pad', 0, 60),
      note('pad', 0, 62),
      note('bass', 0, 36),
      note('lead', 0, 64),
      note('arp', 0, 65),
      note('bell', 0, 74),
      note('texture', 0, 55),
      note('hat', 0, 42),
      note('kick', 0, 36),
    ];
    const result = mixdown(events, 64);

    expect(peakPolyphony(result, 64)).toBeLessThanOrEqual(MAX_CONCURRENT_NOTES);
    // hat is last in rank order, so it is the first thing to go.
    expect(result.map((event) => event.voice)).not.toContain('hat');
    // Everything that matters survives.
    for (const voice of ['pad', 'bass', 'lead'] as const) {
      expect(
        result.map((event) => event.voice),
        voice,
      ).toContain(voice);
    }
  });

  it('counts sustain rather than attacks', () => {
    // Nine notes that start apart but overlap are still nine notes.
    const events = CHORD.map((midi, i) => note('bell', i, midi, 16));
    const result = mixdown(events, 64);
    expect(peakPolyphony(result, 64)).toBeLessThanOrEqual(MAX_CONCURRENT_NOTES);
  });

  it('only drops what it has to', () => {
    const events = CHORD.map((midi) => note('bell', 0, midi));
    expect(mixdown(events, 64)).toHaveLength(MAX_CONCURRENT_NOTES);
  });
});

describe('mixdown', () => {
  it('returns events in canonical order', () => {
    const events = [note('lead', 8, 64), note('pad', 0, 60), note('bass', 0, 36)];
    const result = mixdown(events, 64);
    expect(result.map((event) => event.tick)).toStrictEqual([0, 0, 8]);
  });

  it('does not depend on the order voices were generated in', () => {
    const events = [note('pad', 0, 70), note('lead', 0, 70), note('bass', 0, 36)];
    expect(mixdown(events, 64)).toStrictEqual(mixdown([...events].reverse(), 64));
  });

  it('is deterministic', () => {
    const events = [note('pad', 0, 70), note('lead', 0, 70)];
    expect(mixdown(events, 64)).toStrictEqual(mixdown(events, 64));
  });
});
