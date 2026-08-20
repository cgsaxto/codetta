import type { Column } from './layout';
import type { Palette } from './palette';
import type { VoiceId } from '../music/score';

/**
 * The repository, being read — painted onto whatever 2D context it is handed.
 *
 * Separated from React because there are now two things that need to draw it. One is the
 * canvas on the page, sized by a layout and driven by the transport. The other is an
 * offscreen canvas at 1080 square or 1080×1920, driven by a recorder. If those were two
 * implementations, the video would be a picture of a slightly different piece than the one on
 * screen, and the only way anyone would find out is by watching both.
 *
 * Every measurement below is derived from the width and height it is given. Nothing here
 * knows what size it is drawing at, which is what lets the same code fill a 172px tile and a
 * vertical video frame.
 */

/** How fast a column's flare fades, per second. Slow enough to leave a trail, not a strobe. */
const FLARE_DECAY = 1.6;

/** How long a file stays lit after the read line crosses it. */
const FRESH_SECONDS = 0.55;

/** Room at the edges, as a fraction of the smaller side, so marks never touch the frame. */
const INSET = 0.04;

/**
 * The least vertical room a file mark may have before the field stops drawing all of them.
 *
 * Detail is bounded by two separate things. The frame budget asks what a machine can afford;
 * this asks what the space can hold. Two hundred and fifty-six marks in a tile two hundred
 * pixels tall overlap into a solid block — every frame drawn on time, and nothing legible in
 * any of them.
 */
const MIN_MARK_SPACING = 2.2;

export interface Scene {
  columns: readonly Column[];
  palette: Palette;
  /** How many files the repository has, which sets how thick a mark can be. */
  fileCount: number;
  /** Seconds the whole piece runs, for deciding how recently a file was read. */
  durationSeconds: number;
  /** Ticks in the whole piece, for turning a position into a fraction. */
  totalTicks: number;
  /** Stops the flaring and leaves the reading, for anyone who asked for less motion. */
  calm?: boolean;
}

export interface Frame {
  tick: number;
  onsets: readonly { voice: VoiceId }[];
  /** Seconds since the previous frame, for anything that decays rather than follows. */
  delta: number;
  /** How much of the optional detail this machine can afford, 1 being all of it. */
  stride?: number;
}

/**
 * Flare levels, held by the caller between frames.
 *
 * Passed in rather than kept here because a module-level map would be shared by every canvas
 * drawing at once — the page and the recorder would fight over one set of levels, and each
 * would see the other's notes.
 */
export type Flares = Map<VoiceId, number>;

export function drawField(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  scene: Scene,
  frame: Frame,
  flares: Flares,
): void {
  const { columns, palette, calm = false } = scene;

  const inset = Math.min(width, height) * INSET;
  const innerWidth = width - inset * 2;
  const innerHeight = height - inset * 2;
  const markHeight = Math.min(6, Math.max(1.5, (height / Math.max(1, scene.fileCount)) * 0.55));

  for (const onset of frame.onsets) flares.set(onset.voice, 1);

  context.fillStyle = palette.ground;
  context.fillRect(0, 0, width, height);

  const read = scene.totalTicks > 0 ? frame.tick / scene.totalTicks : 0;
  const readY = inset + read * innerHeight;
  const readSeconds = read * scene.durationSeconds;

  const fits = Math.max(
    1,
    Math.ceil((scene.fileCount * MIN_MARK_SPACING) / Math.max(1, innerHeight)),
  );
  const step = Math.max(frame.stride ?? 1, fits);

  for (const column of columns) {
    const x = inset + column.x * innerWidth;
    const columnWidth = Math.max(1, column.width * innerWidth);
    const colour = palette.modules[column.rank] ?? palette.quiet;

    const flare = calm
      ? 0
      : Math.max(0, (flares.get(column.voice) ?? 0) - frame.delta * FLARE_DECAY);
    flares.set(column.voice, flare);

    // The column's own body. Always drawn, which is what gives it an edge and makes its
    // width — and so the loudness of the voice it belongs to — something you can see.
    context.fillStyle = colour;
    context.globalAlpha = 0.07 + flare * 0.1;
    context.fillRect(x, inset, columnWidth, innerHeight);

    // The part already read, tinted harder. Progress becomes an area rather than the
    // position of a line, which is the only reading that survives a small screen.
    context.globalAlpha = 0.16 + flare * 0.14;
    context.fillRect(x, inset, columnWidth, Math.max(0, readY - inset));

    for (const [index, mark] of column.marks.entries()) {
      // Thinned only when the machine cannot keep up, or the space cannot hold them all.
      if (index % step !== 0) continue;
      const y = inset + mark.y * innerHeight;
      const age = readSeconds - mark.y * scene.durationSeconds;
      const fresh = !calm && age >= 0 && age < FRESH_SECONDS ? 1 - age / FRESH_SECONDS : 0;
      const passed = y <= readY;

      // Unread files are the repository's structure, visible before a note is played. Read
      // files are brighter; a file the line has just crossed is brightest, because the event
      // worth watching is a file being read rather than a line moving.
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

  // Quiet on purpose. The files carry the reading; a bright hairline across everything is a
  // playhead, and a playhead is the one thing this is trying not to be.
  context.fillStyle = palette.modules[0] ?? palette.quiet;
  context.globalAlpha = 0.42;
  context.fillRect(inset, readY, innerWidth, 1);
  context.globalAlpha = 1;
}
