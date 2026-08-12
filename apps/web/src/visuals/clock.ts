import { TICKS_PER_BEAT, type NoteEvent } from '../music/score';

/**
 * Where the piece is, and what just happened, in Score ticks.
 *
 * Pure: no Tone, no canvas, no clock of its own. It is handed a number of seconds and
 * answers questions about it, which is what makes the awkward part of a visualiser — the
 * part where a frame straddles a loop boundary — something a test can pin down.
 *
 * ## The rule this file exists to keep
 *
 * The animation frame decides *when to paint*. It never decides *where the piece is*. That
 * comes from the audio clock, every frame, freshly.
 *
 * Accumulating elapsed time from frame timestamps instead is the same mistake as scheduling
 * notes with setTimeout, and it fails the same way: the two clocks are close enough that a
 * few seconds look fine, and far enough apart that a minute does not. A dropped frame, a
 * background tab, or a browser that throttles rAF all move the visual and leave the audio
 * where it was. Reading the position instead of integrating it makes drift unrepresentable
 * rather than merely unlikely — and Phase 4 records this canvas alongside this audio, where
 * a drift of a beat is the difference between a clip worth posting and one that looks broken.
 */

/**
 * Seconds into the piece → position in Score ticks, wrapped into the loop.
 *
 * Fractional on purpose. A visual that can only be on a sixteenth moves in sixteen steps a
 * bar however smooth the framerate is, and reads as a slideshow rather than as motion.
 */
export function ticksAtSeconds(seconds: number, bpm: number, totalTicks: number): number {
  if (!Number.isFinite(seconds) || !(bpm > 0) || !(totalTicks > 0)) return 0;

  const ticks = seconds * (bpm / 60) * TICKS_PER_BEAT;
  if (!Number.isFinite(ticks)) return 0;

  // Twice, because the remainder of a negative number is negative in JavaScript and a
  // position behind the start is what a transport reports in the moment before it begins.
  return ((ticks % totalTicks) + totalTicks) % totalTicks;
}

/**
 * The notes that begin in the window a frame covers, `[from, to)`.
 *
 * Half-open, and that end rather than the other, so every onset fires exactly once: a note
 * on tick 0 belongs to the first frame of a playthrough, and belongs again to the first
 * frame after the loop comes back around to it.
 *
 * A frame whose window crosses the loop point covers two ranges rather than an empty one.
 * That case is roughly one frame in every three thousand, which is exactly the sort of thing
 * that survives to production and then shows up as a stutter once a loop, so it is handled
 * here where a test can reach it rather than in a draw call where nothing can.
 */
export function onsetsBetween(
  events: readonly NoteEvent[],
  from: number,
  to: number,
  totalTicks: number,
): NoteEvent[] {
  if (!(totalTicks > 0) || from === to) return [];

  const within = (tick: number, start: number, end: number) => tick >= start && tick < end;
  const wrapped = to < from;

  return events.filter((event) =>
    wrapped
      ? within(event.tick, from, totalTicks) || within(event.tick, 0, to)
      : within(event.tick, from, to),
  );
}

/**
 * The notes sounding at a position, and how far through each one is on 0–1.
 *
 * The progress is what a visual element needs in order to decay: a note is not a moment, it
 * has a length, and something that only knows an onset can only blink.
 */
export interface SoundingNote {
  event: NoteEvent;
  /** 0 at the attack, approaching 1 at the release. */
  progress: number;
}

export function soundingAt(events: readonly NoteEvent[], tick: number): SoundingNote[] {
  const out: SoundingNote[] = [];

  for (const event of events) {
    const age = tick - event.tick;
    if (age < 0 || age >= event.durationTicks) continue;
    out.push({ event, progress: event.durationTicks > 0 ? age / event.durationTicks : 0 });
  }

  return out;
}
