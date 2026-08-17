/**
 * The frame budget: what to give up when a machine cannot keep up.
 *
 * docs/roadmap.md is specific about the direction — "degrade element count, never
 * framerate" — and the reason is Phase 4. This canvas gets recorded alongside this audio,
 * and a recorder samples frames on a clock of its own: a piece that renders at 40 fps does
 * not produce a slower video, it produces a video that stutters against music which is still
 * exactly on time. Dropping marks is invisible. Dropping frames is the artefact.
 *
 * Pure, so the awkward parts — that it must shed detail quickly and restore it slowly, and
 * that it must never reach zero — are things a test can hold rather than things you find out
 * on someone else's laptop.
 */

/** Frame times either side of 60 fps. Between them, nothing changes. */
const SLOW_MS = 21; // about 48 fps
const FAST_MS = 15; // comfortably inside 60 fps

/**
 * Shed in big steps, restore in small ones.
 *
 * Symmetric adjustment oscillates: detail drops, frames get cheap, detail returns, frames get
 * expensive again, and the picture pulses at a rate that has nothing to do with the music.
 * Restoring four times slower than shedding settles instead.
 */
const SHED = 0.08;
const RESTORE = 0.02;

/**
 * The floor. A quarter of the files still reads as a repository being traversed; nothing at
 * all reads as a bug, and a degradation strategy that can blank the screen is worse than the
 * slow frames it was avoiding.
 */
export const MIN_DETAIL = 0.25;

/** How much of the optional detail to draw next frame, 0–1. */
export function adjustDetail(detail: number, frameMs: number): number {
  if (!Number.isFinite(frameMs) || frameMs <= 0) return detail;

  const next =
    frameMs > SLOW_MS ? detail - SHED : frameMs < FAST_MS ? detail + RESTORE : detail;
  return Math.min(1, Math.max(MIN_DETAIL, next));
}

/**
 * Draw every nth element, rather than the first n.
 *
 * Taking a prefix would empty the bottom of the field and leave the top untouched, which is
 * the same mistake the file cap made in apps/api — a sample keeps the shape, a truncation
 * keeps one corner of it. A fixed stride also keeps the same marks on screen from frame to
 * frame, so shedding detail dims the picture instead of making it flicker.
 */
export function stride(detail: number): number {
  // Guarded rather than clamped, because Math.max(0.25, NaN) is NaN: the clamp propagates it
  // instead of catching it, `index % NaN` is never 0, and every mark would be skipped. A
  // blank field is exactly what the floor above exists to prevent, so it cannot be reachable
  // through the arithmetic that implements the floor.
  if (!Number.isFinite(detail)) return 1;
  return Math.max(1, Math.round(1 / Math.min(1, Math.max(MIN_DETAIL, detail))));
}

/**
 * Exponentially smoothed frames per second, for a readout.
 *
 * Raw frame times are far too noisy to read: one 40 ms hitch in an otherwise perfect second
 * makes an instantaneous counter unreadable, and the number that matters is the one you can
 * watch for a few seconds and believe.
 */
export function smoothFps(previous: number, frameMs: number): number {
  if (!Number.isFinite(frameMs) || frameMs <= 0) return previous;
  const instant = 1000 / frameMs;
  return previous > 0 ? previous * 0.9 + instant * 0.1 : instant;
}
