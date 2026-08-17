import { useEffect, useMemo, useRef } from 'react';
import type { RepoFeatures } from '@codetta/schema';
import type { Player } from '../audio/player';
import { barToTick, scoreDurationSeconds, type Score, type VoiceId } from '../music/score';
import { fieldFor } from './layout';
import { paletteFor } from './palette';
import { useTransportFrame } from './useTransportFrame';

/**
 * The repository, being read.
 *
 * A column per module, as wide as that module is large; inside it the module's files, each a
 * rule as long as it has lines and indented as deep as it nests. A line descends the field
 * over the piece, in the repository's own traversal order, and the part of the repository it
 * has passed stays lit. When a voice plays, the column it belongs to answers.
 *
 * ## What the first version got wrong
 *
 * The concept read as "a progress line sweeping a black player" rather than as a repository,
 * and every reason was the same reason: the picture was almost entirely ground, and the
 * ground carried nothing.
 *
 * Columns had no body, only the gap between their marks, so their boundaries were invisible
 * and the width-to-loudness mapping — the thing that makes the picture and the music agree —
 * could not be seen at all. Unread files sat at 16% of a neutral grey, so before pressing
 * play there was no structure on screen to recognise. And the colour lived only in the marks
 * and the read line, so repositories with genuinely different hues all reduced to near-black
 * plus one neon hairline once the image was small.
 *
 * So the palette now runs the whole surface: the ground, each column's own body, the unread
 * files, the read files and the voice that is sounding. And the read region of every column
 * is tinted more strongly than the unread region, which makes progress through the repository
 * legible as an area rather than as the position of a line — the one reading that survives
 * being watched at thumbnail size.
 *
 * The event is a file being read, not a line moving. A mark the read line has just crossed
 * flares and settles, so what you watch is the parser meeting files one after another; the
 * line itself is deliberately quiet, because a bright full-width hairline is a playhead and
 * says nothing about code.
 */

/** How fast a column's flare fades, per second. Slow enough to leave a trail, not a strobe. */
const FLARE_DECAY = 1.6;

/** How long a file stays lit after the read line crosses it. */
const FRESH_SECONDS = 0.55;

/** Room at the edges, as a fraction of the smaller side, so marks never touch the frame. */
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
  const duration = useMemo(() => scoreDurationSeconds(score), [score]);

  // The motion is the content here, so this does not disable it — it stops the flaring and
  // leaves the reading, which is the part that carries meaning rather than energy.
  const calm = useMemo(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  );

  // One mark per file, so a repository of forty files needs thicker rules than one of two
  // hundred and fifty to occupy the same field.
  const markHeight = useMemo(() => {
    const count = Math.max(1, features.timeline.length);
    return Math.min(6, Math.max(1.5, (height / count) * 0.55));
  }, [features.timeline.length, height]);

  /**
   * The last frame drawn, so a resize can put it back.
   *
   * Setting `canvas.width` or `canvas.height` resets the bitmap to transparent — that is what
   * the attributes do, not just what they describe. A ResizeObserver delivers its first
   * callback asynchronously after `observe`, which lands after the still-frame effect below
   * has already painted, so the paint was being wiped and the canvas left transparent over a
   * white page. It only showed while stopped: during playback the next animation frame
   * repaints within milliseconds and hides it entirely.
   */
  const lastFrame = useRef<{ tick: number; delta: number }>({ tick: 0, delta: 0 });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const resize = () => {
      const ratio = window.devicePixelRatio || 1;
      const nextWidth = Math.round(canvas.clientWidth * ratio);
      const nextHeight = Math.round(height * ratio);
      // Assigning the same value still clears, so the guard is what keeps a resize
      // notification that changed nothing from blanking a good frame.
      if (canvas.width !== nextWidth || canvas.height !== nextHeight) {
        canvas.width = nextWidth;
        canvas.height = nextHeight;
      }
      canvas.getContext('2d')?.setTransform(ratio, 0, 0, ratio, 0, 0);
      paintRef.current(lastFrame.current.tick, [], lastFrame.current.delta);
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [height]);

  // Declared before the effects that call it, and held in a ref so they depend on the data
  // they draw rather than on a function rebuilt every render.
  const paintRef = useRef<
    (tick: number, onsets: readonly { voice: VoiceId }[], delta: number) => void
  >(() => {});

  const paint = (tick: number, onsets: readonly { voice: VoiceId }[], delta: number) => {
    lastFrame.current = { tick, delta };
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
    const readSeconds = read * duration;

    for (const column of columns) {
      const x = inset + column.x * innerWidth;
      const columnWidth = Math.max(1, column.width * innerWidth);
      const colour = palette.modules[column.rank] ?? palette.quiet;

      const flare = calm
        ? 0
        : Math.max(0, (flares.current.get(column.voice) ?? 0) - delta * FLARE_DECAY);
      flares.current.set(column.voice, flare);

      // The column's own body. Always drawn, which is what gives it an edge and makes its
      // width — and so the loudness of the voice it belongs to — something you can see.
      context.fillStyle = colour;
      context.globalAlpha = 0.07 + flare * 0.1;
      context.fillRect(x, inset, columnWidth, innerHeight);

      // The part already read, tinted harder. Progress becomes an area rather than the
      // position of a line, which is the only reading that survives a small screen.
      context.globalAlpha = 0.16 + flare * 0.14;
      context.fillRect(x, inset, columnWidth, Math.max(0, readY - inset));

      for (const mark of column.marks) {
        const y = inset + mark.y * innerHeight;
        const age = readSeconds - mark.y * duration;
        const fresh = !calm && age >= 0 && age < FRESH_SECONDS ? 1 - age / FRESH_SECONDS : 0;
        const passed = y <= readY;

        // Unread files are the repository's structure, visible before a note is played.
        // Read files are brighter; a file the line has just crossed is brightest, because
        // the event worth watching is a file being read rather than a line moving.
        context.globalAlpha = passed ? 0.62 + flare * 0.2 + fresh * 0.38 : 0.3;
        context.fillStyle = colour;
        context.fillRect(
          x + mark.indent * columnWidth,
          y - markHeight / 2,
          Math.max(1, mark.length * columnWidth),
          markHeight * (1 + fresh * 0.9),
        );
      }

      context.globalAlpha = 1;
    }

    // Quiet on purpose. The files carry the reading; a bright hairline across everything is
    // a playhead, and a playhead is the one thing this is trying not to be.
    context.fillStyle = palette.modules[0] ?? palette.quiet;
    context.globalAlpha = 0.42;
    context.fillRect(inset, readY, innerWidth, 1);
    context.globalAlpha = 1;
  };

  paintRef.current = paint;

  useTransportFrame(player, score, ({ tick, onsets, delta }) => paint(tick, onsets, delta));

  // Paint once while stopped, so the repository's structure is on screen before anything
  // plays rather than the field being an empty rectangle until you press a button.
  useEffect(() => {
    if (!player) paintRef.current(0, [], 0);
  }, [player, columns, palette, markHeight, height]);

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
