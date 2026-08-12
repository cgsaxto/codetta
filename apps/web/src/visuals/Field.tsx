import { useEffect, useMemo, useRef } from 'react';
import type { RepoFeatures } from '@codetta/schema';
import type { Player } from '../audio/player';
import { barToTick, type Score, type VoiceId } from '../music/score';
import { fieldFor } from './layout';
import { paletteFor } from './palette';
import { useTransportFrame } from './useTransportFrame';

/**
 * The repository, being read.
 *
 * A column per module, as wide as that module is large; inside it the module's files, each a
 * rule as long as it has lines and indented as deep as it nests. A line descends the field
 * over the piece, in the repository's own traversal order, and everything it has passed
 * stays lit. When a voice plays, the column it belongs to answers.
 *
 * ## Why not a waveform
 *
 * Because a waveform would be true of any audio and say nothing about this repository, and
 * the whole claim of this project is that the structure became the music. Indentation is
 * what code looks like once you are far enough away to lose the letters, which makes this
 * the vernacular a developer already reads rather than an abstraction invented for the
 * occasion — and six forms stay legible at the size a clip is actually watched, where two
 * hundred and fifty-six file dots would be texture at best.
 *
 * The one deliberate extravagance is the trail: a note leaves its column glowing and the
 * glow decays over about a second. Everything else holds still.
 */

/** How fast a column's flare fades, per second. Slow enough to leave a trail, not a strobe. */
const FLARE_DECAY = 1.6;

/** Room at the edges, as a fraction of the field, so marks never touch the frame. */
const INSET = 0.04;

export interface FieldProps {
  player: Player | null;
  score: Score;
  features: RepoFeatures;
  /** Height in CSS pixels. Width follows the container. */
  height?: number;
}

export function Field({ player, score, features, height = 300 }: FieldProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const flares = useRef(new Map<VoiceId, number>());

  const columns = useMemo(() => fieldFor(features), [features]);
  const palette = useMemo(() => paletteFor(score.seed), [score.seed]);
  const totalTicks = useMemo(() => barToTick(score.bars), [score.bars]);

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

  const paint = (tick: number, onsets: readonly { voice: VoiceId }[], delta: number) => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;

    const width = canvas.clientWidth;
    const inset = Math.min(width, height) * INSET;
    const innerWidth = width - inset * 2;
    const innerHeight = height - inset * 2;

    for (const onset of onsets) flares.current.set(onset.voice, 1);

    context.fillStyle = palette.ground;
    context.fillRect(0, 0, width, height);

    const read = totalTicks > 0 ? tick / totalTicks : 0;
    const readY = inset + read * innerHeight;

    for (const column of columns) {
      const x = inset + column.x * innerWidth;
      const columnWidth = column.width * innerWidth;
      const colour = palette.modules[column.rank] ?? palette.quiet;

      // Time-based, so a trail looks the same at 30 fps and at 120.
      const flare = Math.max(0, (flares.current.get(column.voice) ?? 0) - delta * FLARE_DECAY);
      flares.current.set(column.voice, flare);

      // The column's own ground, lifted while its voice is sounding. This is what makes a
      // note read as belonging to a module rather than to the piece in general.
      if (flare > 0) {
        context.globalAlpha = flare * 0.14;
        context.fillStyle = colour;
        context.fillRect(x, inset, columnWidth, innerHeight);
        context.globalAlpha = 1;
      }

      for (const mark of column.marks) {
        const y = inset + mark.y * innerHeight;
        const passed = y <= readY;

        // Read and unread rather than on and off: the part of the repository already heard
        // stays visible, so the picture accumulates instead of merely blinking.
        context.globalAlpha = passed ? 0.55 + flare * 0.45 : 0.16;
        context.fillStyle = passed ? colour : palette.quiet;
        context.fillRect(
          x + mark.indent * columnWidth,
          y,
          Math.max(1, mark.length * columnWidth),
          1.5,
        );
      }

      context.globalAlpha = 1;
    }

    // The read line: hairline, full width, the one thing that moves continuously.
    context.fillStyle = palette.modules[0] ?? palette.quiet;
    context.globalAlpha = 0.9;
    context.fillRect(inset, readY, innerWidth, 1);
    context.globalAlpha = 1;
  };

  useTransportFrame(player, score, ({ tick, onsets, delta }) => paint(tick, onsets, delta));

  // Held in a ref so the still frame below depends on the data it draws rather than on the
  // function, which is rebuilt every render and would re-run the effect constantly.
  const paintRef = useRef(paint);
  paintRef.current = paint;

  // Paint once while stopped, so the repository is visible before anything plays rather than
  // the field being an empty rectangle until you press a button.
  useEffect(() => {
    if (!player) paintRef.current(0, [], 0);
  }, [player, columns, palette, height]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: '100%', height }}
      aria-label={`${features.repo.owner}/${features.repo.name} drawn as ${columns.length} modules`}
      role="img"
      className="rounded"
    />
  );
}
