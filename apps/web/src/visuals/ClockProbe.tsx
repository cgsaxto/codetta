import { useEffect, useMemo, useRef } from 'react';
import type { Player } from '../audio/player';
import {
  TICKS_PER_BAR,
  TICKS_PER_BEAT,
  VOICE_ORDER,
  type Score,
  type VoiceId,
} from '../music/score';
import { useTransportFrame } from './useTransportFrame';

/**
 * A probe, not a design.
 *
 * Sync is the one property of a visualiser that cannot be checked by reading the code or by
 * running a test: a hundred milliseconds of lead looks exactly like no lead at all in a
 * screenshot, and exactly like a mistake when you watch it against the bass.
 *
 * The first version of this drew one flash for every onset in the piece, which turned out to
 * be useless in two separate ways. It conflated six voices, so "it looks off" could not be
 * attributed to any of them; and its flash outlasted the gap between onsets — 167 ms of decay
 * against a 156 ms median gap — so on most repositories it was simply lit the whole time.
 *
 * One lane per voice, decaying inside the shortest gap, answers the question the single flash
 * could not: whether a mismatch belongs to the clock, which is shared by every voice, or to a
 * particular sound. A sine bass at C1 has a thirty-millisecond cycle and no transient to
 * speak of, and the ear cannot place its onset the way it places a plucked one — that is a
 * fact about hearing rather than about timing, and it looks identical from inside the code.
 *
 * Everything here is placeholder: greys, rectangles, no identity. The look is a separate
 * pass, so that a judgement about timing is never confused with one about taste.
 */

const LANE_HEIGHT = 16;
const LABEL_WIDTH = 52;
const PADDING = 6;

/**
 * How fast a flash fades, per second. Fast enough to go dark between two sixteenths at the
 * quickest tempo the skeleton allows — otherwise a lane reads as "on" rather than as a
 * sequence of events, which is what made the first probe unreadable.
 */
const DECAY = 14;

export function ClockProbe({ player, score }: { player: Player | null; score: Score }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Survives frames without re-rendering: how bright each lane currently is.
  const flashes = useRef(new Map<VoiceId, number>());

  // Only the voices this piece actually uses, in the canonical order so the lanes do not
  // move around between repositories.
  const voices = useMemo(() => {
    const present = new Set(score.events.map((event) => event.voice));
    return VOICE_ORDER.filter((voice) => present.has(voice));
  }, [score]);

  const height = voices.length * LANE_HEIGHT + PADDING * 2;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const resize = () => {
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.round(canvas.clientWidth * ratio);
      canvas.height = Math.round(height * ratio);
      canvas.getContext('2d')?.setTransform(ratio, 0, 0, ratio, 0, 0);
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [height]);

  useTransportFrame(player, score, ({ tick, onsets, delta }) => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;

    const width = canvas.clientWidth;
    const laneWidth = Math.max(0, width - LABEL_WIDTH);

    for (const onset of onsets) flashes.current.set(onset.voice, 1);

    context.clearRect(0, 0, width, height);
    context.font = '10px ui-monospace, monospace';
    context.textBaseline = 'middle';

    // One bar wide, so the playhead crosses it once a bar and any lead or lag against the
    // beat shows up as a gap between the line and a lane lighting.
    const positionInBar = tick % TICKS_PER_BAR;

    voices.forEach((voice, index) => {
      const y = PADDING + index * LANE_HEIGHT;
      // Time-based rather than per-frame, so it looks the same at 30 fps and at 120.
      const level = Math.max(0, (flashes.current.get(voice) ?? 0) - delta * DECAY);
      flashes.current.set(voice, level);

      context.fillStyle = '#a3a3a3';
      context.fillText(voice, 0, y + LANE_HEIGHT / 2);

      context.fillStyle = '#f5f5f5';
      context.fillRect(LABEL_WIDTH, y + 3, laneWidth, LANE_HEIGHT - 6);

      if (level > 0) {
        context.globalAlpha = level;
        context.fillStyle = '#171717';
        context.fillRect(LABEL_WIDTH, y + 3, laneWidth, LANE_HEIGHT - 6);
        context.globalAlpha = 1;
      }
    });

    for (let beat = 0; beat < TICKS_PER_BAR / TICKS_PER_BEAT; beat++) {
      const x = LABEL_WIDTH + (beat / 4) * laneWidth;
      context.fillStyle = '#e5e5e5';
      context.fillRect(x, PADDING, 1, height - PADDING * 2);
    }

    context.fillStyle = '#171717';
    context.fillRect(LABEL_WIDTH + (positionInBar / TICKS_PER_BAR) * laneWidth, 0, 1.5, height);
  });

  return (
    <canvas
      ref={canvasRef}
      style={{ width: '100%', height }}
      aria-hidden
      className="rounded border border-neutral-200"
    />
  );
}
