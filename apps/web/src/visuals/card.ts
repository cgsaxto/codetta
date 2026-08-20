import type { RepoFeatures } from '@codetta/schema';
import { clipWindow } from '../music/clip';
import { barToTick, scoreDurationSeconds, type Score } from '../music/score';
import { ticksAtSeconds } from './clock';
import { drawField } from './draw';
import { fieldFor } from './layout';
import type { Palette } from './palette';

/**
 * The card: the repository drawn, with its name and — when the visitor arrived by typing
 * their username — their face on it.
 *
 * One function, drawn onto whatever context it is handed, for the same reason `drawField` is
 * one function. Two of these existed for about an hour: the link-unfurl card built its text
 * out of DOM for a screenshot to capture, and the downloadable one would have had to build
 * the same text out of canvas calls, since a screenshot is not available to a visitor. Two
 * implementations of one picture drift, and the drift here would be a downloaded card that
 * is subtly not the card people see in a timeline.
 *
 * So the text is canvas text in both, and the unfurl card is now this function plus a
 * screenshot rather than a layout of its own.
 *
 * The frame it draws is the last one of the clip — the thirty seconds starting at the peak,
 * the same window the WAV and the video are cut from. A card is a still of the thing being
 * shared, and this is the only frame that is one. It was tick 0 first, on the argument that
 * the card should show what a gallery tile shows before anything plays. At tile size that
 * reads as structure; at 1200×630 it is a dark rectangle with a hairline across the top,
 * because the whole legibility of this picture is the contrast between the region that has
 * been read and the region that has not, and at tick 0 there is no read region at all.
 */

/** What every platform crops a link preview to, and so what every card is. */
export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

export interface CardSubject {
  features: RepoFeatures;
  score: Score;
  palette: Palette;
  /**
   * The account whose most-starred repository this is, when a username chose it. Loaded from
   * a data URI the API inlined — a cross-origin image taints a canvas, and a tainted canvas
   * cannot be turned into a file at all, so the card would silently stop being downloadable.
   */
  avatar?: CanvasImageSource | undefined;
}

export function shortLines(count: number): string {
  return count >= 1000 ? `${Math.round(count / 1000)}k lines` : `${count} lines`;
}

/** What the piece is, in the terms the rest of the site uses. */
export function cardCaption(features: RepoFeatures, score: Score): string {
  const mode = score.mode.charAt(0).toUpperCase() + score.mode.slice(1);
  return [
    features.repo.primaryLanguage,
    shortLines(features.totals.linesOfCode),
    `${score.root} ${mode}`,
    `${score.bpm} BPM`,
  ]
    .filter(Boolean)
    .join('  ·  ');
}

/**
 * A palette colour at an opacity, as an 8-digit hex.
 *
 * The palette writes every colour as `#rrggbb` on purpose — canvas silently ignores a
 * fillStyle it cannot parse and leaves the previous colour in place — so this stays in the
 * same notation rather than reaching for a function whose support it would have to assume.
 */
function withAlpha(colour: string, alpha: number): string {
  if (!/^#[0-9a-f]{6}$/i.test(colour)) return colour;
  const channel = Math.round(Math.min(1, Math.max(0, alpha)) * 255)
    .toString(16)
    .padStart(2, '0');
  return colour + channel;
}

/**
 * Letter-spaced text, drawn a character at a time.
 *
 * `context.letterSpacing` would do it in one call and is missing from enough browsers that a
 * visitor on the wrong one would get a card whose wordmark is set differently from every
 * other card. Seven characters is not worth a capability check.
 */
function drawTracked(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  tracking: number,
): void {
  let cursor = x;
  for (const character of text) {
    context.fillText(character, cursor, y);
    cursor += context.measureText(character).width + tracking;
  }
}

/**
 * The frame a card is a picture of: the last one of the clip.
 *
 * Separated out because it is the one number on this card that has been wrong before, and it
 * was wrong in a way no test could see — at tick 0 every drawing call still happens and the
 * result is a dark rectangle.
 */
export function cardTick(score: Score): number {
  const clip = clipWindow(score);
  return ticksAtSeconds(
    clip.startSeconds + clip.durationSeconds,
    score.bpm,
    barToTick(score.bars),
  );
}

export function drawCard(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  subject: CardSubject,
): void {
  const { features, score, palette, avatar } = subject;
  const totalTicks = barToTick(score.bars);

  drawField(
    context,
    width,
    height,
    {
      columns: fieldFor(features),
      palette,
      fileCount: features.timeline.length,
      durationSeconds: scoreDurationSeconds(score),
      totalTicks,
      // Nothing is playing into a still, so a flare would be an invented one.
      calm: true,
    },
    { tick: cardTick(score), onsets: [], delta: 0 },
    new Map(),
  );

  // Every measurement below is in card units and scaled, so one layout serves the 1200×630
  // this is normally drawn at and any other size someone hands it.
  const unit = width / CARD_WIDTH;
  const accent = palette.modules[0] ?? '#ffffff';
  const left = 56 * unit;
  const baseline = height - 48 * unit;

  /*
   * A gradient of the card's own ground, under the text.
   *
   * Without it the file marks of whichever module happens to sit at the bottom left run
   * straight through the caption — legible in isolation, and not at the size a link preview
   * is actually looked at. It fades into the picture rather than boxing the text, and it
   * takes the bottom of the field, which is the part no read line has reached and so the
   * part with the least in it.
   */
  const scrimHeight = 250 * unit;
  const scrim = context.createLinearGradient(0, height - scrimHeight, 0, height);
  scrim.addColorStop(0, withAlpha(palette.ground, 0));
  scrim.addColorStop(0.55, withAlpha(palette.ground, 0.78));
  scrim.addColorStop(1, withAlpha(palette.ground, 0.94));
  context.fillStyle = scrim;
  context.fillRect(0, height - scrimHeight, width, scrimHeight);

  let textLeft = left;
  if (avatar) {
    const size = 104 * unit;
    const x = left;
    const y = baseline - size + 10 * unit;

    context.save();
    context.beginPath();
    context.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
    context.clip();
    context.drawImage(avatar, x, y, size, size);
    context.restore();

    // A ring in the repository's own colour, which is what ties the face to the picture
    // behind it rather than leaving it pasted on.
    context.beginPath();
    context.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
    context.strokeStyle = accent;
    context.globalAlpha = 0.9;
    context.lineWidth = 2 * unit;
    context.stroke();
    context.globalAlpha = 1;

    textLeft = x + size + 26 * unit;
  }

  context.fillStyle = accent;
  context.textBaseline = 'alphabetic';

  context.globalAlpha = 0.75;
  context.font = `${15 * unit}px ${MONO}`;
  drawTracked(context, 'CODETTA', textLeft, baseline - 74 * unit, 4.8 * unit);

  context.globalAlpha = 1;
  context.font = `500 ${46 * unit}px ${MONO}`;
  context.fillText(
    `${features.repo.owner}/${features.repo.name}`,
    textLeft,
    baseline - 24 * unit,
  );

  context.globalAlpha = 0.62;
  context.font = `${17 * unit}px ${MONO}`;
  context.fillText(cardCaption(features, score), textLeft, baseline);
  context.globalAlpha = 1;
}

/** Filename for a saved card. Matches what the WAV and the video are named. */
export function cardFilename(owner: string, name: string): string {
  return `codetta-${owner}-${name}-card.png`.toLowerCase();
}

/**
 * Decode an inlined avatar into something a canvas can draw.
 *
 * Resolves to undefined rather than rejecting: a card without a face is a card, and a save
 * that fails because a thumbnail did not decode would be a worse outcome than the one it was
 * protecting against. Same judgement the API makes when it fetches the thing.
 */
export function loadAvatar(
  dataUri: string | undefined,
): Promise<CanvasImageSource | undefined> {
  if (!dataUri) return Promise.resolve(undefined);

  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(undefined);
    image.src = dataUri;
  });
}

/**
 * Draw a card offscreen and hand it back as a PNG.
 *
 * Twice the size it is displayed at, like the pre-rendered ones, because the place this ends
 * up is a retina timeline and the whole picture is thin marks on a dark ground.
 */
export async function renderCard(subject: CardSubject, scale = 2): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = CARD_WIDTH * scale;
  canvas.height = CARD_HEIGHT * scale;

  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser would not give Codetta a canvas to draw on.');

  // Fonts have to be resident before the first fillText, or the card is set in whatever the
  // browser had lying around. The screenshot path waits for the same thing.
  if (document.fonts?.ready) await document.fonts.ready;

  drawCard(context, canvas.width, canvas.height, subject);

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      // The one realistic cause is a tainted canvas, which is exactly what inlining the
      // avatar prevents — so if this ever fires, that is the thing to look at.
      else reject(new Error('Codetta could not turn the card into an image.'));
    }, 'image/png');
  });
}
