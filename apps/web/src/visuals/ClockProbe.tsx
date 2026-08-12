import { useEffect, useRef } from 'react';
import type { Player } from '../audio/player';
import { TICKS_PER_BAR, TICKS_PER_BEAT, type Score } from '../music/score';
import { useTransportFrame } from './useTransportFrame';

/**
 * A probe, not a design.
 *
 * Sync is the one property of a visualiser that cannot be checked by reading the code or by
 * running a test: a hundred milliseconds of lead looks exactly like no lead at all in a
 * screenshot, and exactly like a mistake when you watch it against the bass. So the first
 * thing built is the smallest thing that makes the clock visible — a playhead across one bar
 * and a flash on every onset — and the question it answers is only "does this land with what
 * I am hearing".
 *
 * Everything here is placeholder: greys, a rectangle, no identity. The look comes later and
 * separately, so that a judgement about timing is never confused with one about taste.
 */

const HEIGHT = 56;

export function ClockProbe({ player, score }: { player: Player | null; score: Score }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Survives across frames without re-rendering: how bright the flash currently is.
  const flash = useRef(0);

  // Backing-store size follows the display size and the device pixel ratio, or every line is
  // soft on the machines most people have.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const resize = () => {
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.round(canvas.clientWidth * ratio);
      canvas.height = Math.round(HEIGHT * ratio);
      canvas.getContext('2d')?.setTransform(ratio, 0, 0, ratio, 0, 0);
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useTransportFrame(player, score, ({ tick, onsets, delta }) => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;

    const width = canvas.clientWidth;
    if (onsets.length > 0) flash.current = 1;
    // Time-based decay rather than per-frame, so it looks the same at 30 fps and at 120.
    flash.current = Math.max(0, flash.current - delta * 6);

    context.clearRect(0, 0, width, HEIGHT);

    // One bar wide, so the playhead crosses it four times a bar at walking pace and any lead
    // or lag against the beat is obvious rather than subtle.
    const positionInBar = tick % TICKS_PER_BAR;
    const beat = Math.floor(positionInBar / TICKS_PER_BEAT);

    for (let index = 0; index < TICKS_PER_BAR / TICKS_PER_BEAT; index++) {
      const x = (index / 4) * width;
      context.fillStyle = index === beat ? '#171717' : '#d4d4d4';
      context.fillRect(x, HEIGHT / 2 - 10, 2, 20);
    }

    context.fillStyle = '#171717';
    context.fillRect((positionInBar / TICKS_PER_BAR) * width, 0, 1.5, HEIGHT);

    if (flash.current > 0) {
      context.globalAlpha = flash.current;
      context.fillStyle = '#171717';
      context.beginPath();
      context.arc(width - 14, HEIGHT / 2, 6, 0, Math.PI * 2);
      context.fill();
      context.globalAlpha = 1;
    }
  });

  return (
    <canvas
      ref={canvasRef}
      style={{ width: '100%', height: HEIGHT }}
      aria-hidden
      className="rounded border border-neutral-200"
    />
  );
}
