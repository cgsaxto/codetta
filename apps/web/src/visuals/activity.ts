import {
  PERCUSSION_VOICES,
  VOICE_ORDER,
  type NoteEvent,
  type Score,
  type VoiceId,
} from '../music/score';

/**
 * What is sounding, read from the score rather than from the speakers.
 *
 * A visual needs to know how loud each voice is right now. There are two places to get that
 * from, and they are not equally good.
 *
 * An FFT on the master bus measures the *output* of a system whose *input* we are holding in
 * symbolic form. It costs three things to do that. It is not deterministic — the same commit
 * has to produce the same picture, and a spectrum depends on when the frame happened to land.
 * It does not exist offline — the card is a still with no audio at all, and the video is
 * rendered from a buffer, so anything driven by a live analyser cannot appear in either. And
 * it throws away the one thing the picture is actually about: a spectrum knows there is
 * energy near 200 Hz, but not that it was the bass, and a column on screen belongs to a
 * module, which is to say to a voice.
 *
 * This module answers the same question from the score. It is a pure function of tick, so
 * two callers at the same position agree, a test can pin any moment, and an offline renderer
 * gets exactly what the page gets.
 *
 * ## Why not the flare map in draw.ts
 *
 * `Flares` is the same idea integrated frame by frame: set to 1 on an onset, multiplied down
 * by however long the last frame took. That is correct for a canvas being driven by a
 * transport and wrong for anything that has to be reproducible, because the value at a given
 * tick depends on the history of frames that reached it. A dropped frame changes the picture.
 * Here, a level is a function of the notes alone.
 */

/** How the strike falls away while a note is held, in 16th-note ticks. */
const DECAY_TICKS = 3;

/** How it falls away after the note ends. */
const RELEASE_TICKS = 4;

/** Where the decay settles while a note is still held. A held note is not a blink. */
const SUSTAIN = 0.45;

/** Past this many ticks of release the contribution is under a thousandth. */
const TAIL_TICKS = RELEASE_TICKS * 7;

/**
 * A voice's level at a moment, and the register bands those levels fall into.
 *
 * The band split is by pitch, which is what a spectrum would have been measuring anyway —
 * except that here it cannot be empty by construction. The 6–13 kHz band an FFT of this
 * music reports is silent for every repository on earth, because pads, plucks and bells put
 * nothing there; C5 and above is a register this music actually uses.
 */
export interface Activity {
  /** 0–1 per voice. Every voice in VOICE_ORDER is present, silent ones at 0. */
  voices: Readonly<Record<VoiceId, number>>;
  /** Below C3. Bass, the pad's lower voicings, the kick. */
  low: number;
  /** C3 to B4. Where most of the arrangement lives. */
  mid: number;
  /** C5 and above. Bell, the top of the lead, the hat. */
  high: number;
  /**
   * How much of the arrangement is sounding, 0–1.
   *
   * The sum of every voice's level over the number of voices the piece ever uses — so it
   * rises through the build, sits high across the peak, and drops in the break, which is the
   * shape a global glow should follow. Not a loudness: a voice that is playing quietly still
   * counts as playing.
   */
  energy: number;
}

/** C3. Below this is the bass register. */
const LOW_TOP = 48;

/** C5. At or above this is the bright register. */
const HIGH_BOTTOM = 72;

type Band = 'low' | 'mid' | 'high';

const PERCUSSION = new Set<string>(PERCUSSION_VOICES);

/**
 * Which band a note belongs to.
 *
 * Percussion is decided by its voice rather than its pitch. A hat is written at a MIDI number
 * that would put it in the bass register, because a drum's note number names an instrument
 * and not a frequency — reading it as a pitch would file the brightest thing in the kit under
 * "low" and leave the top of the picture dead.
 */
function bandOf(event: NoteEvent): Band {
  if (PERCUSSION.has(event.voice)) return event.voice === 'hat' ? 'high' : 'low';
  if (event.midi < LOW_TOP) return 'low';
  return event.midi >= HIGH_BOTTOM ? 'high' : 'mid';
}

/**
 * A note's contribution at `age` ticks after its onset.
 *
 * Struck instantly, because the grid is sixteenths and an attack slower than that arrives
 * late. Then a decay toward a sustain floor while it is held, and a release after it ends.
 * Fractional ages are expected and are the reason this is a curve rather than a table: a
 * visual that can only be on a sixteenth moves in sixteen steps a bar however smooth the
 * framerate is.
 */
function envelope(age: number, durationTicks: number, velocity: number): number {
  if (age < 0) return 0;

  const held = SUSTAIN + (1 - SUSTAIN) * Math.exp(-age / DECAY_TICKS);
  if (age < durationTicks) return velocity * held;

  const releaseAge = age - durationTicks;
  if (releaseAge > TAIL_TICKS) return 0;

  const atRelease = SUSTAIN + (1 - SUSTAIN) * Math.exp(-durationTicks / DECAY_TICKS);
  return velocity * atRelease * Math.exp(-releaseAge / RELEASE_TICKS);
}

function emptyVoices(): Record<VoiceId, number> {
  return Object.fromEntries(VOICE_ORDER.map((voice) => [voice, 0])) as Record<VoiceId, number>;
}

/** The index of the last event whose tick is at or before `tick`, or -1. */
function lastStartedAt(events: readonly NoteEvent[], tick: number): number {
  let low = 0;
  let high = events.length - 1;
  let found = -1;

  while (low <= high) {
    const middle = (low + high) >> 1;
    if ((events[middle]?.tick ?? 0) <= tick) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

export interface ActivityReader {
  /** The level of every voice at a position in ticks. Fractional ticks are the normal case. */
  at(tick: number): Activity;
}

/**
 * Prepare a score for repeated reads.
 *
 * The sorting and bucketing happen once; `at` is called sixty times a second and only ever
 * looks at the handful of notes that could still be ringing. Nothing is cached between calls,
 * so a caller cannot get a different answer by asking in a different order.
 *
 * Notes are not carried across the loop point. The piece begins with pad and bass alone and
 * has its own onsets there; letting the outro's tail bleed into the first bar would light
 * voices that have just stopped, which is the one moment the arrangement is deliberately bare.
 */
export function prepareActivity(score: Score): ActivityReader {
  const byVoice = new Map<VoiceId, NoteEvent[]>();
  for (const voice of VOICE_ORDER) byVoice.set(voice, []);

  for (const event of score.events) {
    byVoice.get(event.voice)?.push(event);
  }
  for (const events of byVoice.values()) {
    // The canonical event order is by tick already; sorting is cheap insurance against a
    // caller handing us a Score assembled some other way.
    events.sort((a, b) => a.tick - b.tick);
  }

  // How many voices the piece actually uses, so `energy` reaches 1 on a piece with four
  // voices as well as on one with six. A repository with two modules is not perpetually
  // quiet — that is the safety net working, not a dynamic.
  const playing = VOICE_ORDER.filter((voice) => (byVoice.get(voice)?.length ?? 0) > 0).length;

  return {
    at(tick: number): Activity {
      const voices = emptyVoices();
      const bands: Record<Band, number> = { low: 0, mid: 0, high: 0 };

      if (!Number.isFinite(tick)) {
        return { voices, low: 0, mid: 0, high: 0, energy: 0 };
      }

      for (const [voice, events] of byVoice) {
        let level = 0;

        // Backwards from the last note that has started. The first note too old to matter
        // ends the walk: everything before it is older still.
        for (let index = lastStartedAt(events, tick); index >= 0; index--) {
          const event = events[index];
          if (!event) continue;

          const age = tick - event.tick;
          if (age > event.durationTicks + TAIL_TICKS) break;

          const contribution = envelope(age, event.durationTicks, event.velocity);
          if (contribution <= 0) continue;

          // The loudest note wins rather than the sum. Two notes of a chord are one voice
          // sounding, not twice as much of it, and summing would pin a pad at full scale
          // for the whole piece.
          if (contribution > level) level = contribution;

          const band = bandOf(event);
          if (contribution > bands[band]) bands[band] = contribution;
        }

        voices[voice] = level;
      }

      const total = VOICE_ORDER.reduce((sum, voice) => sum + voices[voice], 0);

      return {
        voices,
        low: bands.low,
        mid: bands.mid,
        high: bands.high,
        energy: playing > 0 ? Math.min(1, total / playing) : 0,
      };
    },
  };
}
