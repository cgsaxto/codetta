import { useEffect, useRef } from 'react';
import type { Player } from '../audio/player';
import type { NoteEvent, Score } from '../music/score';
import { barToTick } from '../music/score';
import { onsetsBetween, ticksAtSeconds } from './clock';

/**
 * What a frame knows. Everything here is derived from the audio clock rather than from the
 * frame's own timestamp — see visuals/clock.ts for why that distinction is the whole design.
 */
export interface Frame {
  /** Position in Score ticks, fractional, wrapped into the loop. */
  tick: number;
  /** Notes that began since the previous frame. Each onset appears in exactly one frame. */
  onsets: readonly NoteEvent[];
  /** Seconds since the previous frame, for anything that decays rather than follows. */
  delta: number;
}

/**
 * Runs an animation frame loop while a player is playing, and hands each frame its position.
 *
 * `requestAnimationFrame` is the right tool for *when to paint* — it is what the display is
 * doing anyway. It is the wrong tool for *what time it is*, and the two get conflated
 * constantly. The callback below is given a position read fresh from the audio clock every
 * frame; nothing here accumulates.
 *
 * The callback is deliberately not React state. Sixty setState calls a second would re-render
 * the tree sixty times a second to move some pixels, so `draw` is expected to paint straight
 * onto a canvas. It is held in a ref so that a caller can pass an inline function without
 * restarting the loop on every render.
 */
export function useTransportFrame(
  player: Player | null,
  score: Score,
  draw: (frame: Frame) => void,
): void {
  const drawRef = useRef(draw);
  drawRef.current = draw;

  useEffect(() => {
    if (!player) return;

    const totalTicks = barToTick(score.bars);
    let handle = 0;
    // Seeded with the current position rather than 0, so resuming does not replay every
    // onset between the start of the piece and wherever it actually is.
    let previousTick = ticksAtSeconds(player.positionSeconds(), score.bpm, totalTicks);
    let previousTime = performance.now();

    const frame = (now: number) => {
      handle = requestAnimationFrame(frame);

      const tick = ticksAtSeconds(player.positionSeconds(), score.bpm, totalTicks);
      const onsets = onsetsBetween(score.events, previousTick, tick, totalTicks);
      // Frame timestamps are fine for this: it measures the frame, not the music.
      const delta = Math.max(0, (now - previousTime) / 1000);

      previousTick = tick;
      previousTime = now;

      drawRef.current({ tick, onsets, delta });
    };

    handle = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(handle);
  }, [player, score]);
}
