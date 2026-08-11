import { describe, expect, it } from 'vitest';
import { KIT_IDS } from '../music/score';
import { KITS } from './kits';

/**
 * A kit is allowed to change the character of the sound and nothing else. The constraints
 * below are the ones Phase 0 found by ear over four rounds of listening — chords piling up
 * because a release outlived its bar, an arp smearing into a chord, a bell still ringing
 * when the harmony moved under it. They are why it sounds good rather than stylistic
 * preferences, so a new kit does not get to reopen them by accident.
 */
describe('kits', () => {
  const entries = Object.entries(KITS);

  it('has an entry for every id the Score can carry', () => {
    // The ids are the output contract — a Score naming a kit that does not exist would be a
    // crash at playback, long after the Score validated.
    expect(Object.keys(KITS).sort()).toStrictEqual([...KIT_IDS].sort());
  });

  it('never lets the pad outlive the bar that produced it', () => {
    // Longer, and each chord is still sounding when the next two arrive, which makes the
    // Score's 8-note ceiling a fiction acoustically.
    for (const [id, kit] of entries) {
      expect(kit.pad.release, id).toBeLessThanOrEqual(0.4);
      expect(kit.pad.release, id).toBeGreaterThan(0);
    }
  });

  it('keeps the bell quiet before the harmony moves', () => {
    // A high tone still ringing over the next chord is the most exposed dissonance
    // available, and it reads as the bell being out of tune rather than as a suspension.
    for (const [id, kit] of entries) {
      expect(kit.bell.decay, id).toBeLessThanOrEqual(0.4);
      expect(kit.bell.wet, id).toBeLessThanOrEqual(0.35);
    }
  });

  it('keeps the lead plucked rather than sustaining', () => {
    // A sustaining lead refills the midrange the pad was just cleared out of, and its notes
    // can be as close as a sixteenth apart.
    for (const [id, kit] of entries) {
      expect(kit.lead.decay, id).toBeLessThanOrEqual(0.2);
      expect(kit.lead.sustain, id).toBeLessThanOrEqual(0.25);
    }
  });

  /** Roughly how much energy each waveform puts above its fundamental. */
  const HARMONICS: Record<string, number> = {
    sine: 0,
    fmsine: 1,
    triangle: 2,
    square4: 3,
    sawtooth8: 4,
    sawtooth: 5,
  };

  it('leaves the lead a band of its own, well above the pad', () => {
    // The rule this file exists for, and the one three of the first four kits broke.
    //
    // A pad and a lead a fifth apart in cutoff, on the same waveform, put the tune inside the
    // bed — and it was reported exactly that way: `warm` and `organ` "have no melody" and are
    // "muddy", against an identical Score that read fine under `tape`. Nothing about the
    // notes was different. The pad was simply sitting where the tune was.
    for (const [id, kit] of entries) {
      expect(kit.pad.cutoff, `${id}: pad must be the darkest voice`).toBeLessThanOrEqual(
        Math.min(kit.lead.cutoff, kit.arp.cutoff),
      );

      expect(kit.lead.cutoff / kit.pad.cutoff, `${id}: lead over pad`).toBeGreaterThanOrEqual(
        1.8,
      );
    }
  });

  it('separates by a means that works on the waveform it is using', () => {
    /*
     * The rule the cutoff ratio alone does not catch, and it was audible before it was
     * understood: `tape` and `glass` were reported as having a better tune than `warm` and
     * `organ` even after all four had the same 2x ratio between pad and lead.
     *
     * A lowpass separates two voices only in proportion to how much the lower one has above
     * the cutoff to lose. A triangle falls off at 1/n² — third partial at a ninth, fifth at
     * a twentieth — so moving a triangle pad from 3200 Hz to 1500 removes almost nothing and
     * the lead is still sitting on it. A sawtooth falls off at 1/n, so the same move is
     * drastic, which is why `tape` worked. `glass` worked for the opposite reason: its pad is
     * a sine, with nothing above the fundamental at all.
     *
     * So a kit separates one of two ways, and has to actually pick one. Either the pad's
     * waveform is rich enough for the filter to bite, or the lead's waveform is richer than
     * the pad's. `warm` had neither — triangle under triangle — and was the one kit reported
     * as having no melody.
     */
    const RICH = 3; // square4 and above: enough content for a cutoff to be worth moving.

    for (const [id, kit] of entries) {
      const pad = HARMONICS[kit.pad.oscillator] ?? 0;
      const lead = HARMONICS[kit.lead.oscillator] ?? 0;

      expect(
        pad >= RICH || lead > pad,
        `${id}: a ${kit.pad.oscillator} pad has too little above its fundamental for a ` +
          `filter to separate, so the lead needs a richer waveform than ${kit.lead.oscillator}`,
      ).toBe(true);
    }
  });

  it('rolls a brighter bed off harder, so no kit is louder than the others', () => {
    // Cutoff moves against harmonic content, on the voices that sustain. Without it the saw
    // kit arrives louder than the sine kit at identical gain and the mix balance, which was
    // set by ear, stops meaning anything.
    for (const [id, kit] of entries) {
      for (const voice of ['pad', 'arp'] as const) {
        const content = HARMONICS[kit[voice].oscillator] ?? 0;
        const ceiling = content >= 3 ? 2000 : 6000;
        expect(kit[voice].cutoff, `${id} ${voice}`).toBeLessThanOrEqual(ceiling);
        expect(kit[voice].cutoff, `${id} ${voice}`).toBeGreaterThan(800);
      }
    }
  });

  it('leaves the bass its filter envelope rather than opening it wide', () => {
    // The bass problem was never brightness, it was that its harmonics sustain. The envelope
    // opens for the attack and shuts to near the fundamental; a kit that opened it far would
    // put the third harmonic back under the pad's lowest note.
    for (const [id, kit] of entries) {
      expect(kit.bass.octaves, id).toBeGreaterThanOrEqual(2);
      expect(kit.bass.octaves, id).toBeLessThanOrEqual(3.5);
    }
  });

  it('is actually four different sounds', () => {
    // The whole reason this exists. Two kits differing only in a cutoff would be a row in a
    // table that no listener could tell from its neighbour.
    const signatures = entries.map(([, kit]) =>
      [kit.pad.oscillator, kit.lead.oscillator, kit.arp.oscillator, kit.bell.oscillator].join(),
    );
    expect(new Set(signatures).size).toBe(entries.length);
  });
});
