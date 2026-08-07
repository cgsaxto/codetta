import { describe, expect, it } from 'vitest';
import {
  MODE_NAMES,
  PROGRESSIONS,
  ROOT_NAMES,
  allValidPairs,
  midiToNote,
  pickProgression,
  realizeProgression,
  type Progression,
} from './progressions';

function progressionById(id: string): Progression {
  const found = PROGRESSIONS.find((p) => p.id === id);
  if (!found) throw new Error(`No progression with id "${id}".`);
  return found;
}

describe('progressions', () => {
  it('never produces a diminished or augmented triad in any declared mode', () => {
    for (const { progression, mode } of allValidPairs()) {
      for (const root of ROOT_NAMES) {
        const chords = realizeProgression(progression, mode, root);
        for (const chord of chords) {
          expect(
            chord.quality,
            `${progression.id} / ${mode} / ${root} / degree ${chord.degree}`,
          ).toMatch(/^(maj|min)$/);
        }
      }
    }
  });

  it('always returns four bars', () => {
    for (const { progression, mode } of allValidPairs()) {
      expect(realizeProgression(progression, mode, 'C')).toHaveLength(4);
    }
  });

  it('is deterministic', () => {
    const nightfall = progressionById('nightfall');
    const a = realizeProgression(nightfall, 'aeolian', 'D');
    const b = realizeProgression(nightfall, 'aeolian', 'D');
    expect(a).toStrictEqual(b);
  });

  it('rejects a mode the progression is not verified in', () => {
    expect(() => realizeProgression(progressionById('updraft'), 'aeolian', 'C')).toThrow();
  });

  it('names MIDI notes correctly', () => {
    expect(midiToNote(60)).toBe('C4');
    expect(midiToNote(48)).toBe('C3');
    expect(midiToNote(69)).toBe('A4');
  });

  it('places the tonic at the requested octave', () => {
    const [firstBar] = realizeProgression(progressionById('nightfall'), 'aeolian', 'C', {
      octave: 3,
    });
    expect(firstBar?.midi[0]).toBe(48);
    expect(firstBar?.notes[0]).toBe('C3');
  });

  it('stacks only diatonic sevenths, and does not change the triad underneath', () => {
    for (const { progression, mode } of allValidPairs()) {
      for (const root of ROOT_NAMES) {
        const triads = realizeProgression(progression, mode, root);
        const sevenths = realizeProgression(progression, mode, root, { seventh: true });

        for (const [bar, chord] of sevenths.entries()) {
          const label = `${progression.id} / ${mode} / ${root} / bar ${bar}`;
          expect(chord.midi, label).toHaveLength(4);
          // The triad must be untouched — adding a seventh may not re-voice anything.
          expect(chord.midi.slice(0, 3), label).toStrictEqual(triads[bar]?.midi);
          // A diatonic seventh is always a minor (10) or major (11) seventh. A 9 would
          // be a sixth, which means the stacking maths has drifted off the scale.
          const root7 = chord.midi[3];
          const rootNote = chord.midi[0];
          expect(rootNote).toBeDefined();
          expect(root7).toBeDefined();
          expect([10, 11], label).toContain((root7 ?? 0) - (rootNote ?? 0));
        }
      }
    }
  });
});

describe('pickProgression', () => {
  const RNG_SAMPLES = [0, 0.25, 0.5, 0.75, 0.999999];

  it('has at least one candidate for every mode the skeleton can select', () => {
    for (const mode of MODE_NAMES) {
      expect(
        PROGRESSIONS.some((p) => p.modes.includes(mode)),
        mode,
      ).toBe(true);
    }
  });

  it('only ever returns a progression verified in the requested mode', () => {
    for (const mode of MODE_NAMES) {
      for (const sample of RNG_SAMPLES) {
        const chosen = pickProgression(mode, () => sample);
        expect(chosen.modes, `${mode} @ ${sample}`).toContain(mode);
      }
    }
  });

  it('returns the same progression for the same rng value', () => {
    expect(pickProgression('aeolian', () => 0.42)).toBe(pickProgression('aeolian', () => 0.42));
  });

  it('clamps rather than throwing if the rng violates its [0, 1) contract', () => {
    for (const mode of MODE_NAMES) {
      expect(() => pickProgression(mode, () => 1)).not.toThrow();
      expect(pickProgression(mode, () => 1).modes).toContain(mode);
    }
  });
});
