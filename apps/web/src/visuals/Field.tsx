import { useEffect, useMemo, useRef } from 'react';
import type { RepoFeatures } from '@codetta/schema';
import type { Player } from '../audio/player';
import { barToTick, scoreDurationSeconds, type Score, type VoiceId } from '../music/score';
import { adjustDetail, smoothFps, stride } from './budget';
import { drawField } from './draw';
import { fieldFor } from './layout';
import { paletteFor, type Palette } from './palette';
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

export interface FieldProps {
  player: Player | null;
  score: Score;
  features: RepoFeatures;
  /** Height in CSS pixels. Width follows the container. */
  height?: number;
  /** Smoothed frames per second, reported so a machine can be checked rather than assumed. */
  onFrameRate?: (fps: number) => void;
  /**
   * Overrides the colour this repository would pick alone.
   *
   * A gallery resolves collisions across the whole set — see palettesFor — so the tile has
   * to be told which hue it ended up with rather than deriving one that a neighbour has
   * already claimed.
   */
  palette?: Palette;
}

export function Field({
  player,
  score,
  features,
  height = 300,
  onFrameRate,
  palette: given,
}: FieldProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const flares = useRef(new Map<VoiceId, number>());

  // How much of the optional detail this machine can afford, and what it is managing. Refs
  // rather than state: both change every frame and neither belongs in a render.
  const detail = useRef(1);
  const fps = useRef(0);
  const reported = useRef(0);

  const columns = useMemo(() => fieldFor(features), [features]);
  const palette = useMemo(() => given ?? paletteFor(score.seed), [given, score.seed]);
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

    drawField(
      context,
      canvas.clientWidth,
      height,
      {
        columns,
        palette,
        fileCount: features.timeline.length,
        durationSeconds: duration,
        totalTicks,
        calm,
      },
      { tick, onsets, delta, stride: stride(detail.current) },
      flares.current,
    );
  };

  paintRef.current = paint;

  useTransportFrame(player, score, ({ tick, onsets, delta }) => {
    // Measured before drawing, from the gap since the last frame, so the level applied is
    // the one this machine has actually been managing rather than a guess about this frame.
    const frameMs = delta * 1000;
    detail.current = adjustDetail(detail.current, frameMs);
    fps.current = smoothFps(fps.current, frameMs);

    paint(tick, onsets, delta);

    // Rounded before reporting, so a readout costs a render only when the number it shows
    // would actually change rather than sixty times a second.
    const rounded = Math.round(fps.current);
    if (onFrameRate && rounded !== reported.current) {
      reported.current = rounded;
      onFrameRate(rounded);
    }
  });

  // Paint once while stopped, so the repository's structure is on screen before anything
  // plays rather than the field being an empty rectangle until you press a button.
  useEffect(() => {
    if (!player) paintRef.current(0, [], 0);
  }, [player, columns, palette, features.timeline.length, height]);

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
