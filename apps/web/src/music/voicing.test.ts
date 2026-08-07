import { describe, expect, it } from 'vitest';
import { placementsInRange, voiceLead } from './voicing';

const PAD: readonly [number, number] = [48, 72];

/** C major, F major, G major, A minor as pitch classes. */
const LOOP = [
  [0, 4, 7],
  [5, 9, 0],
  [7, 11, 2],
  [9, 0, 4],
];

function totalMovement(voicings: readonly (readonly number[])[]): number {
  let total = 0;
  for (let i = 1; i < voicings.length; i++) {
    const previous = voicings[i - 1] ?? [];
    const current = voicings[i] ?? [];
    total += current.reduce((sum, midi, v) => sum + Math.abs(midi - (previous[v] ?? midi)), 0);
  }
  return total;
}

describe('placementsInRange', () => {
  it('finds every octave of a pitch class inside the register', () => {
    expect(placementsInRange(0, 48, 72)).toStrictEqual([48, 60, 72]);
    expect(placementsInRange(7, 48, 72)).toStrictEqual([55, 67]);
  });

  it('normalises pitch classes outside 0–11', () => {
    expect(placementsInRange(60, 48, 72)).toStrictEqual(placementsInRange(0, 48, 72));
    expect(placementsInRange(-5, 48, 72)).toStrictEqual(placementsInRange(7, 48, 72));
  });

  it('returns nothing when the register cannot hold the note', () => {
    expect(placementsInRange(1, 48, 48)).toStrictEqual([]);
  });
});

describe('voiceLead', () => {
  it('keeps every note inside the register', () => {
    for (const voicing of voiceLead(LOOP, PAD)) {
      for (const midi of voicing) {
        expect(midi).toBeGreaterThanOrEqual(PAD[0]);
        expect(midi).toBeLessThanOrEqual(PAD[1]);
      }
    }
  });

  it('keeps every chord tone, one note per pitch class', () => {
    const voicings = voiceLead(LOOP, PAD);
    for (const [i, voicing] of voicings.entries()) {
      expect(voicing).toHaveLength(3);
      expect(new Set(voicing).size, `chord ${i}`).toBe(3);
      expect(new Set(voicing.map((midi) => midi % 12))).toStrictEqual(new Set(LOOP[i]));
    }
  });

  it('returns each voicing in ascending order', () => {
    for (const voicing of voiceLead(LOOP, PAD)) {
      expect(voicing).toStrictEqual([...voicing].sort((a, b) => a - b));
    }
  });

  it('moves less than root-position transposition would', () => {
    // The comparison that justifies this module existing. Root position means every chord
    // starts on its own root, so the whole pad leaps whenever the progression does.
    const rootPosition = LOOP.map((pitchClasses) =>
      pitchClasses.map((pitchClass, i) => {
        const base = placementsInRange(pitchClass, PAD[0], PAD[1])[0] ?? PAD[0];
        return base + (i > 0 && base < (pitchClasses[0] ?? 0) ? 12 : 0);
      }),
    );
    expect(totalMovement(voiceLead(LOOP, PAD))).toBeLessThan(totalMovement(rootPosition));
  });

  it('never moves a voice more than a tritone between chords', () => {
    const voicings = voiceLead(LOOP, PAD);
    for (let i = 1; i < voicings.length; i++) {
      const previous = voicings[i - 1] ?? [];
      const current = voicings[i] ?? [];
      for (const [v, midi] of current.entries()) {
        expect(
          Math.abs(midi - (previous[v] ?? midi)),
          `chord ${i} voice ${v}`,
        ).toBeLessThanOrEqual(6);
      }
    }
  });

  it('centres the opening chord rather than hugging an end of the register', () => {
    const [first] = voiceLead(LOOP, PAD);
    const centre = (PAD[0] + PAD[1]) / 2;
    const average = (first ?? []).reduce((sum, midi) => sum + midi, 0) / (first?.length ?? 1);
    expect(Math.abs(average - centre)).toBeLessThanOrEqual(4);
  });

  it('widens the interval between voices as they descend', () => {
    // The rule that stops the pad turning to mud: a third at 150 Hz smears, the same third
    // an octave up is clear. Minimum movement alone will not find this.
    for (const voicing of voiceLead(LOOP, PAD)) {
      for (let i = 1; i < voicing.length; i++) {
        const lower = voicing[i - 1] ?? 0;
        const gap = (voicing[i] ?? 0) - lower;
        const required = lower < 52 ? 12 : lower < 60 ? 7 : 3;
        expect(gap, `voice at midi ${lower}`).toBeGreaterThanOrEqual(required);
      }
    }
  });

  it('keeps the lowest pad note clear of the bass register', () => {
    // Bass tops out at C2 (36). Its harmonics reach well above that, so a pad note down
    // near C3 competes with them for the same few hundred hertz.
    for (const voicing of voiceLead(LOOP, PAD)) {
      expect(voicing[0]).toBeGreaterThanOrEqual(52);
    }
  });

  it('is deterministic', () => {
    expect(voiceLead(LOOP, PAD)).toStrictEqual(voiceLead(LOOP, PAD));
  });

  it('refuses a register that cannot hold the chord', () => {
    expect(() => voiceLead(LOOP, [60, 61])).toThrow(/register/);
  });
});
