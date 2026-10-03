import { TICKS_PER_BEAT } from '../music/score';

/**
 * Where the piece is, in Score ticks.
 *
 * Pure: no Tone, no canvas, no clock of its own. It is handed a number of seconds and says
 * where that is. What is sounding there is `activity.ts`, which is a function of the same
 * position — nothing in the visuals asks what happened since the last frame, so nothing
 * depends on how the frames arrived.
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
