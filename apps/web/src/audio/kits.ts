import type { KitId } from '../music/score';

/**
 * The waveforms a kit may ask for, enumerated rather than left open.
 *
 * Band-limited variants where one exists: an ideal square at C5 puts partials past 10 kHz,
 * and the difference between kits should be character rather than one of them being harsh.
 */
export type Waveform = 'sine' | 'triangle' | 'square4' | 'sawtooth' | 'sawtooth8' | 'fmsine';

/**
 * The instrument palettes. One is chosen per repository, from the seed, in music/skeleton.ts.
 *
 * ## Why this exists
 *
 * Root, mode, progression and tempo all vary by repository, and it still all sounded like one
 * track transposed. That is the correct diagnosis of a real measurement rather than a guess:
 * every repository shared six identical instruments, one song-structure template, one phrase
 * grid, one accent pattern, one chord per bar and a bass on beats 1 and 3. Key is the least
 * salient thing a listener uses to tell two pieces apart, so it was carrying a job it cannot
 * do. Instrumentation is what actually reads as "a different piece".
 *
 * ## What a kit may and may not change
 *
 * A kit is a table of timbre numbers, and deliberately nothing else. It does not touch gains,
 * registers, effect topology, or any of the envelope constraints that Phase 0 found by ear:
 * the pad's release still has to die inside its own bar, the arp's decay still has to finish
 * inside its own slot, the bell still has to be quiet before the harmony moves, and the bass
 * still gets a filter envelope rather than a fixed cutoff. Those are why it sounds good; they
 * are not stylistic choices and no kit gets to reopen them.
 *
 * So the shape below is fixed and only the numbers move. A kit cannot make the mix louder,
 * muddier or longer-tailed than the one that passed the gate — the worst it can do is be a
 * timbre somebody dislikes, which is a thing ears can settle.
 *
 * Cutoffs move in the opposite direction to the harmonic content, so a brighter oscillator
 * does not also arrive louder than the kit beside it.
 *
 * ## The pad has to be the darkest thing in the kit
 *
 * The first four kits got this wrong in three of four cases, and it was audible immediately:
 * `warm` and `organ` were reported as having no melody and as muddy, while `tape` — the same
 * notes, the same arrangement — read as having the steadiest tune of the three. The Score is
 * identical across kits, so none of that was about the melody. It was masking.
 *
 * `warm` put a triangle pad at 2600 Hz under a triangle lead at 3200, which is the same
 * waveform a fifth apart in cutoff: the lead had nowhere to be. `organ` was worse, because
 * square4's odd harmonics pile into the midrange where the tune lives. `tape` worked by
 * accident of having the darkest pad in the set, which left the middle of the spectrum empty.
 *
 * So the rule, enforced in kits.test.ts: **the pad is the darkest voice, and the lead sits at
 * least 1.8× above it.** Making the lead louder instead would be the wrong fix — a lead that
 * is audible because it is loud sounds stuck in front of the track, where one that is audible
 * because nothing else occupies its band just sounds like the tune.
 *
 * `glass` gets its separation from waveform rather than cutoff, because a filter has almost
 * nothing to do to a sine. Its pad is a sine — a fundamental and nothing else, which is as
 * dark as a voice can be — and its lead is a triangle, which has harmonics to be heard by.
 */

export interface Kit {
  /** Shown in the UI. Not an identifier — that is the KitId key. */
  readonly label: string;
  readonly pad: {
    readonly oscillator: Waveform;
    readonly cutoff: number;
    /** Fraction of a bar. Must stay well under 1 or chords pile up. */
    readonly release: number;
  };
  readonly bass: {
    readonly oscillator: Waveform;
    /** How far the filter envelope opens over its 90 Hz base. */
    readonly octaves: number;
  };
  readonly lead: {
    readonly oscillator: Waveform;
    readonly cutoff: number;
    /** Fraction of a bar. Plucked, so short. */
    readonly decay: number;
    readonly sustain: number;
  };
  readonly arp: {
    readonly oscillator: Waveform;
    readonly cutoff: number;
  };
  readonly bell: {
    readonly oscillator: Waveform;
    /** Fraction of a bar. The tail has to be gone before the chord changes. */
    readonly decay: number;
    readonly wet: number;
  };
  readonly texture: {
    readonly oscillator: Waveform;
  };
}

export const KITS: Readonly<Record<KitId, Kit>> = {
  /**
   * The one that passed the Phase 0 gate, unchanged. Kept as an entry rather than as a
   * default so that "the sound we know is good" is a row in the same table as the rest and
   * can be compared against them directly.
   */
  warm: {
    label: 'warm',
    // The pad drops from 2600 to 1500. It is the same triangle it always was, and the
    // envelopes and gains that passed the Phase 0 gate are untouched — what changed is that
    // it no longer sits in the band its own lead is trying to sing in.
    pad: { oscillator: 'triangle', cutoff: 1500, release: 0.35 },
    bass: { oscillator: 'triangle', octaves: 3.2 },
    lead: { oscillator: 'triangle', cutoff: 3200, decay: 0.12, sustain: 0.12 },
    arp: { oscillator: 'triangle', cutoff: 2100 },
    bell: { oscillator: 'sine', decay: 0.35, wet: 0.26 },
    texture: { oscillator: 'triangle' },
  },

  /**
   * Hollow and clean. Sines have no harmonics to filter, so the cutoffs open up — closing
   * them would only remove the fundamental. The lead sustains a little longer here because a
   * pure sine with a short decay reads as a click rather than a note.
   */
  glass: {
    label: 'glass',
    // A sine pad is a fundamental and nothing else, which is the darkest a voice gets, so
    // the separation here is waveform rather than cutoff — a filter has almost nothing to do
    // to a sine, and lowering its cutoff would only remove the note.
    pad: { oscillator: 'sine', cutoff: 2000, release: 0.35 },
    bass: { oscillator: 'sine', octaves: 2.6 },
    lead: { oscillator: 'triangle', cutoff: 4200, decay: 0.16, sustain: 0.16 },
    arp: { oscillator: 'sine', cutoff: 3000 },
    bell: { oscillator: 'fmsine', decay: 0.3, wet: 0.3 },
    texture: { oscillator: 'sine' },
  },

  /**
   * Square-ish and stationary, which is what makes an organ read as an organ. Four partials
   * rather than an ideal square: the odd harmonics are the character, the ones above the
   * fourth are only shrillness. Cutoffs come down to match the extra content.
   */
  organ: {
    label: 'organ',
    // The muddiest of the four, and the reason was square4 in the bed: its odd harmonics
    // land exactly where the tune lives. The character moves to the figure — square4 keeps
    // the lead and the arp, and the pad becomes a triangle at half its old cutoff. An organ
    // is recognisable by the line it plays, not by its accompaniment.
    pad: { oscillator: 'triangle', cutoff: 1300, release: 0.3 },
    bass: { oscillator: 'square4', octaves: 2.8 },
    lead: { oscillator: 'square4', cutoff: 2600, decay: 0.14, sustain: 0.16 },
    arp: { oscillator: 'square4', cutoff: 1800 },
    bell: { oscillator: 'triangle', decay: 0.32, wet: 0.24 },
    texture: { oscillator: 'triangle' },
  },

  /**
   * Saw-based and rolled off hard. A sawtooth carries every harmonic, so this is the kit
   * where the cutoffs do the most work — the character is the filter, not the oscillator,
   * and left open it would be the one kit that sounds louder than the others at equal gain.
   */
  tape: {
    label: 'tape',
    // The one that already worked, and the reference the other three were pulled toward. Its
    // separation was the widest of the four by accident; widening it further is the smallest
    // change here, and deliberately so — this is the kit that has been judged good.
    pad: { oscillator: 'sawtooth8', cutoff: 1200, release: 0.32 },
    bass: { oscillator: 'sawtooth', octaves: 3.0 },
    lead: { oscillator: 'sawtooth8', cutoff: 2400, decay: 0.13, sustain: 0.1 },
    arp: { oscillator: 'sawtooth8', cutoff: 1700 },
    bell: { oscillator: 'triangle', decay: 0.34, wet: 0.28 },
    texture: { oscillator: 'sawtooth8' },
  },
};
