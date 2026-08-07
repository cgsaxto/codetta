import { describe, expect, it } from 'vitest';
import {
  MAX_CONCURRENT_NOTES,
  TICKS_PER_BAR,
  assertValidScore,
  barToTick,
  scoreDurationSeconds,
  sortEvents,
  tickToSeconds,
  validateScore,
  type NoteEvent,
  type Score,
} from './score';

/** 40 bars at 108 BPM is 88.9 s, the top template from the Layer 4 table. */
function baseScore(): Score {
  return {
    seed: '7c8e5e7a',
    bpm: 108,
    root: 'C',
    mode: 'aeolian',
    progressionId: 'nightfall',
    bars: 40,
    sections: [
      { name: 'intro', startBar: 0, bars: 4 },
      { name: 'build', startBar: 4, bars: 8 },
      { name: 'peak', startBar: 12, bars: 12 },
      { name: 'break', startBar: 24, bars: 4 },
      { name: 'return', startBar: 28, bars: 8 },
      { name: 'outro', startBar: 36, bars: 4 },
    ],
    events: sortEvents([
      { voice: 'pad', tick: 0, durationTicks: 16, midi: 48, velocity: 0.5 },
      { voice: 'bass', tick: 0, durationTicks: 4, midi: 24, velocity: 0.8 },
      { voice: 'lead', tick: 8, durationTicks: 2, midi: 60, velocity: 0.6 },
      { voice: 'kick', tick: 0, durationTicks: 1, midi: 36, velocity: 1 },
    ]),
    timbre: { texture: { openness: 0.4 } },
  };
}

function withEvents(events: NoteEvent[]): Score {
  return { ...baseScore(), events: sortEvents(events) };
}

function kinds(score: Score): string[] {
  return validateScore(score).map((problem) => problem.kind);
}

describe('timing helpers', () => {
  it('converts bars and ticks', () => {
    expect(barToTick(0)).toBe(0);
    expect(barToTick(4)).toBe(64);
    expect(TICKS_PER_BAR).toBe(16);
  });

  it('converts ticks to seconds', () => {
    // One bar at 120 BPM is two seconds.
    expect(tickToSeconds(TICKS_PER_BAR, 120)).toBeCloseTo(2, 10);
  });

  it('reports the duration the Layer 4 table promises', () => {
    expect(scoreDurationSeconds(baseScore())).toBeCloseTo(88.89, 2);
  });
});

describe('validateScore', () => {
  it('accepts a well-formed score', () => {
    expect(validateScore(baseScore())).toStrictEqual([]);
    expect(() => assertValidScore(baseScore())).not.toThrow();
  });

  it('rejects a tempo above the ceiling', () => {
    expect(kinds({ ...baseScore(), bpm: 132 })).toContain('tempo');
  });

  it('rejects a piece that is not 60–90 seconds', () => {
    // 40 bars at 60 BPM is 160 s. Nothing else about the score changes.
    expect(kinds({ ...baseScore(), bpm: 60 })).toContain('duration');
  });

  it('rejects a note off the 16th grid', () => {
    const events = baseScore().events.map((event) =>
      event.voice === 'lead' ? { ...event, tick: 8.5 } : event,
    );
    expect(kinds(withEvents(events))).toContain('grid');
  });

  it('rejects a note shorter than a 16th', () => {
    expect(
      kinds(withEvents([{ voice: 'pad', tick: 0, durationTicks: 0, midi: 48, velocity: 0.5 }])),
    ).toContain('grid');
  });

  it('rejects a note that runs past the end of the piece', () => {
    const lastTick = barToTick(40) - 1;
    expect(
      kinds(
        withEvents([
          { voice: 'pad', tick: lastTick, durationTicks: 8, midi: 48, velocity: 0.5 },
        ]),
      ),
    ).toContain('grid');
  });

  it('rejects a pitch outside the active scale', () => {
    // 49 is D flat: not a degree of C Aeolian.
    expect(
      kinds(withEvents([{ voice: 'pad', tick: 0, durationTicks: 4, midi: 49, velocity: 0.5 }])),
    ).toContain('pitch');
  });

  it('rejects a pitch outside the voice register', () => {
    // 84 is in C Aeolian but two octaves above the pad's C3–C5.
    expect(
      kinds(withEvents([{ voice: 'pad', tick: 0, durationTicks: 4, midi: 84, velocity: 0.5 }])),
    ).toContain('register');
  });

  it('rejects a velocity outside (0, 1]', () => {
    for (const velocity of [0, -0.1, 1.5]) {
      expect(
        kinds(withEvents([{ voice: 'pad', tick: 0, durationTicks: 4, midi: 48, velocity }])),
        `velocity ${velocity}`,
      ).toContain('velocity');
    }
  });

  it('refuses to let percussion carry a melody', () => {
    expect(
      kinds(withEvents([{ voice: 'kick', tick: 0, durationTicks: 1, midi: 38, velocity: 1 }])),
    ).toContain('pitch');
  });

  it('rejects an openness outside 0–1', () => {
    // Normalised, because audio/ owns the cutoff palette it indexes into.
    expect(kinds({ ...baseScore(), timbre: { texture: { openness: 1.4 } } })).toContain(
      'timbre',
    );
    expect(kinds({ ...baseScore(), timbre: { texture: { openness: -0.1 } } })).toContain(
      'timbre',
    );
  });

  it('rejects events that are not in canonical order', () => {
    const score = baseScore();
    expect(kinds({ ...score, events: [...score.events].reverse() })).toContain('ordering');
  });
});

describe('polyphony ceiling', () => {
  /** All in C Aeolian and inside the pad's register, so only the count is under test. */
  const STACK = [48, 50, 51, 53, 55, 56, 58, 60, 62];

  function chord(size: number): Score {
    return withEvents(
      STACK.slice(0, size).map((midi) => ({
        voice: 'pad' as const,
        tick: 0,
        durationTicks: 4,
        midi,
        velocity: 0.4,
      })),
    );
  }

  it('allows exactly the ceiling', () => {
    expect(kinds(chord(MAX_CONCURRENT_NOTES))).not.toContain('polyphony');
  });

  it('rejects one note over the ceiling', () => {
    expect(kinds(chord(MAX_CONCURRENT_NOTES + 1))).toContain('polyphony');
  });

  it('counts sustain, not just attacks', () => {
    // Nine notes, none starting together, but all still sounding at tick 8.
    const events = STACK.map((midi, i) => ({
      voice: 'pad' as const,
      tick: i,
      durationTicks: 16,
      midi,
      velocity: 0.4,
    }));
    expect(kinds(withEvents(events))).toContain('polyphony');
  });
});

describe('section template', () => {
  it('rejects a section that is not a multiple of 4 bars', () => {
    const score = baseScore();
    expect(
      kinds({
        ...score,
        bars: 38,
        sections: [
          { name: 'intro', startBar: 0, bars: 4 },
          { name: 'build', startBar: 4, bars: 8 },
          { name: 'peak', startBar: 12, bars: 10 },
          { name: 'break', startBar: 22, bars: 4 },
          { name: 'return', startBar: 26, bars: 8 },
          { name: 'outro', startBar: 34, bars: 4 },
        ],
      }),
    ).toContain('sections');
  });

  it('rejects sections that leave a gap', () => {
    const score = baseScore();
    const sections = score.sections.map((section) =>
      section.name === 'break' ? { ...section, startBar: 25 } : section,
    );
    expect(kinds({ ...score, sections })).toContain('sections');
  });

  it('rejects sections that do not cover the declared bar count', () => {
    const score = baseScore();
    expect(kinds({ ...score, bars: 44 })).toContain('sections');
  });

  it('rejects sections in the wrong order', () => {
    const score = baseScore();
    expect(kinds({ ...score, sections: [...score.sections].reverse() })).toContain('sections');
  });
});

describe('assertValidScore', () => {
  it('reports every problem at once', () => {
    const broken: Score = {
      ...baseScore(),
      bpm: 200,
      events: [{ voice: 'pad', tick: 0, durationTicks: 4, midi: 49, velocity: 3 }],
    };
    expect(() => assertValidScore(broken)).toThrow(/tempo/);
    expect(() => assertValidScore(broken)).toThrow(/pitch/);
    expect(() => assertValidScore(broken)).toThrow(/velocity/);
  });
});

describe('sortEvents', () => {
  it('orders by tick, then voice rank, then pitch', () => {
    const sorted = sortEvents([
      { voice: 'lead', tick: 4, durationTicks: 1, midi: 60, velocity: 0.5 },
      { voice: 'bass', tick: 0, durationTicks: 1, midi: 24, velocity: 0.5 },
      { voice: 'pad', tick: 0, durationTicks: 1, midi: 55, velocity: 0.5 },
      { voice: 'pad', tick: 0, durationTicks: 1, midi: 48, velocity: 0.5 },
    ]);
    expect(sorted.map((event) => [event.voice, event.tick, event.midi])).toStrictEqual([
      ['pad', 0, 48],
      ['pad', 0, 55],
      ['bass', 0, 24],
      ['lead', 4, 60],
    ]);
  });

  it('does not mutate its input', () => {
    const events: NoteEvent[] = [
      { voice: 'lead', tick: 4, durationTicks: 1, midi: 60, velocity: 0.5 },
      { voice: 'pad', tick: 0, durationTicks: 1, midi: 48, velocity: 0.5 },
    ];
    sortEvents(events);
    expect(events[0]?.voice).toBe('lead');
  });
});
