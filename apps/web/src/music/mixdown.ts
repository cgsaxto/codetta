import {
  MAX_CONCURRENT_NOTES,
  PERCUSSION_VOICES,
  VOICE_ORDER,
  VOICE_REGISTERS,
  sortEvents,
  type MelodicVoiceId,
  type NoteEvent,
  type VoiceId,
} from './score';

/**
 * The one place that sees every voice at once.
 *
 * The two constraints in docs/music-mapping.md — at most eight notes sounding together, and
 * no two voices on the same pitch at the same time — cannot be enforced inside a voice,
 * because a voice has no idea what the others are playing. Left to per-voice logic they
 * become guesses. Here they are decisions.
 *
 * Pure and deterministic: events go in, events come out, and nothing consults an rng.
 */

function isPercussion(voice: VoiceId): boolean {
  return (PERCUSSION_VOICES as readonly VoiceId[]).includes(voice);
}

function registerOf(voice: VoiceId): readonly [number, number] | undefined {
  return isPercussion(voice) ? undefined : VOICE_REGISTERS[voice as MelodicVoiceId];
}

function overlaps(a: NoteEvent, b: NoteEvent): boolean {
  return a.tick < b.tick + b.durationTicks && b.tick < a.tick + a.durationTicks;
}

/**
 * The voices that compete for the same foreground.
 *
 * Two articulated lines on one pitch mask each other — whichever is quieter simply
 * disappears. An articulated line doubling a sustained bed does not: the pluck still speaks
 * through the pad, and arrangers double a pad on purpose. So a lead note landing on the
 * pad's top note is left exactly where it is.
 *
 * That distinction is not fussiness. Moving one note of a motif up an octave to dodge the
 * pad turns the phrase into a different phrase, which costs far more than the unison ever
 * did. Only collisions between two foreground voices are worth resolving.
 */
const FOREGROUND: ReadonlySet<VoiceId> = new Set<VoiceId>(['lead', 'arp', 'bell']);

function rankOf(voice: VoiceId): number {
  return VOICE_ORDER.indexOf(voice);
}

/**
 * Move the later-ranked voice off a unison, by an octave, if an octave is available inside
 * its own register. If neither octave works the note keeps its pitch: a doubled note is a
 * smaller loss than a hole in the melody.
 *
 * The order this walks in is the rule. Rank, not tick — "the later-ranked voice moves" and
 * "whichever note started first wins" are different rules, and this used to implement the
 * second one by accident, because it walked the canonical order and that sorts by tick. A
 * bell struck on the eighth of a bar therefore outranked a lead note landing on the ninth,
 * and rank 3 shoved rank 1 down an octave in the middle of its own phrase: a -17 semitone
 * leap in a voice that guarantees it never moves by more than a fifth. Once every voice
 * above has been placed, nothing below can reach up and move it.
 */
function resolveUnisons(events: readonly NoteEvent[]): NoteEvent[] {
  const byRank = [...events].sort(
    (a, b) => rankOf(a.voice) - rankOf(b.voice) || a.tick - b.tick || a.midi - b.midi,
  );
  const accepted: NoteEvent[] = [];

  for (const event of byRank) {
    const register = registerOf(event.voice);
    const collides = (midi: number) =>
      accepted.some(
        (other) =>
          other.midi === midi &&
          other.voice !== event.voice &&
          FOREGROUND.has(other.voice) &&
          overlaps(other, event),
      );

    if (!FOREGROUND.has(event.voice) || !register || !collides(event.midi)) {
      accepted.push(event);
      continue;
    }

    const [lo, hi] = register;
    const alternative = [event.midi + 12, event.midi - 12].find(
      (midi) => midi >= lo && midi <= hi && !collides(midi),
    );
    accepted.push(alternative === undefined ? event : { ...event, midi: alternative });
  }

  return accepted;
}

/**
 * Drop notes until nothing exceeds the ceiling, taking from the lowest-ranked voice first.
 * Pad and bass are last in that order and in practice are never reached.
 */
function enforceCeiling(events: readonly NoteEvent[], totalTicks: number): NoteEvent[] {
  const active = new Array<number>(Math.max(totalTicks, 0)).fill(0);
  const add = (event: NoteEvent, delta: number) => {
    for (let tick = event.tick; tick < event.tick + event.durationTicks; tick++) {
      const current = active[tick];
      if (current !== undefined) active[tick] = current + delta;
    }
  };

  for (const event of events) add(event, 1);

  const peakOf = (event: NoteEvent) => {
    let peak = 0;
    for (let tick = event.tick; tick < event.tick + event.durationTicks; tick++) {
      peak = Math.max(peak, active[tick] ?? 0);
    }
    return peak;
  };

  // Least important first, so the melody and the safety net survive a crowded bar.
  const byExpendability = [...events].sort(
    (a, b) => rankOf(b.voice) - rankOf(a.voice) || a.tick - b.tick || a.midi - b.midi,
  );

  const dropped = new Set<NoteEvent>();
  for (const event of byExpendability) {
    if (peakOf(event) <= MAX_CONCURRENT_NOTES) continue;
    dropped.add(event);
    add(event, -1);
  }

  return events.filter((event) => !dropped.has(event));
}

export function mixdown(events: readonly NoteEvent[], totalTicks: number): NoteEvent[] {
  // Canonical order first: both passes below walk the list, and the result must not depend
  // on the order voices happened to be generated in.
  return sortEvents(enforceCeiling(resolveUnisons(sortEvents(events)), totalTicks));
}
