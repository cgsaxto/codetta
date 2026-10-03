import type { RepoFeatures } from '@codetta/schema';
import { GALLERY_BY_SIZE } from '../features/gallery';
import { clipWindow } from '../music/clip';
import { barToTick, type Score } from '../music/score';
import { ticksAtSeconds } from './clock';
import { palettesFor, type Palette } from './palette';

/**
 * The card: the repository drawn, with its name and — when the visitor arrived by typing
 * their username — their face on it.
 *
 * This file is the text and the choices around it; the picture underneath is the page's own
 * 3D scene. Two layouts of the text existed for about an hour: the link-unfurl card built it
 * out of DOM for a screenshot to capture, and the downloadable one would have had to build
 * the same text out of canvas calls, since a screenshot is not available to a visitor. Two
 * implementations of one picture drift, and the drift here would be a downloaded card that
 * is subtly not the card people see in a timeline.
 *
 * So the text is canvas text everywhere it appears — the unfurl card, the downloaded card
 * and the video — drawn by one function onto whatever context it is handed.
 *
 * The frame is the last one of the clip — the thirty seconds starting at the peak, the same
 * window the WAV and the video are cut from. A card is a still of the thing being shared,
 * and this is the only frame that is one. It was tick 0 first, on the argument that the card
 * should show what the page shows before anything plays, and that is the one frame in which
 * every repository looks least like itself: nothing is sounding, so nothing is raised and
 * nothing is lit.
 */

/**
 * The palette a repository wears on its card, which has to be the one it wears on the page.
 *
 * Resolved against the gallery in the page's own order. A gallery repository gets the colour
 * of its tile; anything else is resolved as the page resolves a repository a visitor loaded —
 * appended after the eight — so a card and the screen it was shared from agree.
 */
export function cardPalette(features: RepoFeatures): Palette {
  const seeds = GALLERY_BY_SIZE.map((entry) => entry.seed);
  const at = seeds.indexOf(features.seed);
  return at >= 0
    ? palettesFor(seeds)[at]!
    : palettesFor([...seeds, features.seed])[seeds.length]!;
}

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

/** The title's size when the name is short enough, and the smallest it is allowed to get. */
const TITLE_SIZE = 46;
const TITLE_MIN_SIZE = 32;

/** The fewest characters of a repository's name worth showing around an ellipsis. */
const MIN_NAME_KEPT = 6;

export interface FittedTitle {
  text: string;
  /** In card units, like every other measurement on the card. */
  size: number;
}

function middle(text: string, keep: number): string {
  const characters = Array.from(text);
  if (keep >= characters.length) return text;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${characters.slice(0, head).join('')}…${tail > 0 ? characters.slice(-tail).join('') : ''}`;
}

/**
 * Make `owner/name` fit on one line.
 *
 * The eight gallery names are short and the card was laid out against them. A card anyone can
 * make for any repository meets names like `kubernetes-sigs/aws-load-balancer-controller`,
 * and at a fixed 46px that runs off the right edge — on the one line a card exists to show.
 *
 * Smaller first, because a whole name at 32px is better than a cut one at 46. Then the name
 * loses its middle and keeps both ends, since repository names put what distinguishes them at
 * the end as often as at the start (`-controller`, `-rs`, `.js`). The owner goes last: it is
 * the half of the address a reader is most likely to recognise, and it is only cut when it
 * alone would leave no room for the name.
 *
 * `measure` is handed in so this can be tested without a canvas, and so nothing here assumes
 * the font is monospaced — the stack falls back to whatever `monospace` means on the machine.
 */
export function fitCardTitle(
  owner: string,
  name: string,
  maxWidth: number,
  measure: (text: string, size: number) => number,
): FittedTitle {
  const full = `${owner}/${name}`;

  for (let size = TITLE_SIZE; size >= TITLE_MIN_SIZE; size -= 2) {
    if (measure(full, size) <= maxWidth) return { text: full, size };
  }

  const fits = (text: string) => measure(text, TITLE_MIN_SIZE) <= maxWidth;

  for (let keep = Array.from(name).length - 1; keep >= MIN_NAME_KEPT; keep--) {
    const text = `${owner}/${middle(name, keep)}`;
    if (fits(text)) return { text, size: TITLE_MIN_SIZE };
  }

  for (let keep = Array.from(full).length - 1; keep >= 2; keep--) {
    const text = middle(full, keep);
    if (fits(text)) return { text, size: TITLE_MIN_SIZE };
  }

  return { text: '…', size: TITLE_MIN_SIZE };
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

/**
 * Everything on a card that is not the picture: the scrim, the face if there is one, and the
 * three lines of text.
 *
 * Split out so the picture underneath can change without the text being written twice. The
 * link-unfurl card and the downloadable one both use the same 3D scene, and both
 * wear exactly this — a second copy of the layout would put the name a few pixels somewhere
 * else on one of them, which is the kind of drift nobody catches until two cards sit side by
 * side in a timeline.
 *
 * `ground` is what the scrim fades into, and it has to be whatever is actually behind the text
 * or the fade reads as a grey band.
 */
export function drawCardOverlay(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  subject: CardSubject,
  ground: string,
  /**
   * Type size relative to the card's. A card is read on a timeline at about two fifths of its
   * width; a video is watched on a phone held upright, where the same proportions put the
   * caption near six points. The video asks for more.
   */
  scale = 1,
): void {
  const { features, score, palette, avatar } = subject;

  // Every measurement below is in card units and scaled, so one layout serves the 1200×630
  // this is normally drawn at and any other size someone hands it.
  const unit = (width / CARD_WIDTH) * scale;
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
  scrim.addColorStop(0, withAlpha(ground, 0));
  scrim.addColorStop(0.55, withAlpha(ground, 0.78));
  scrim.addColorStop(1, withAlpha(ground, 0.94));
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

  // The same margin on the right as on the left, so a long name stops where the layout does.
  const title = fitCardTitle(
    features.repo.owner,
    features.repo.name,
    width - textLeft - left,
    (text, size) => {
      context.font = `500 ${size * unit}px ${MONO}`;
      return context.measureText(text).width;
    },
  );

  context.globalAlpha = 0.75;
  context.font = `${15 * unit}px ${MONO}`;
  drawTracked(context, 'CODETTA', textLeft, baseline - 80 * unit, 4.8 * unit);

  context.globalAlpha = 1;
  context.font = `500 ${title.size * unit}px ${MONO}`;
  context.fillText(title.text, textLeft, baseline - 30 * unit);

  // 19px at 0.72, up from 17 at 0.62. A link preview is shown at something like 500px wide,
  // which is this card at two fifths: the line was landing at about 7px in a colour a third
  // of the way to the background, and it is the line that says what the piece is. The title
  // and the wordmark move up six units to give its ascenders the room.
  context.globalAlpha = 0.72;
  context.font = `${19 * unit}px ${MONO}`;
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
  if (!Number.isFinite(scale) || scale <= 0 || scale > 4) {
    throw new Error('The card scale must be greater than zero and no more than four.');
  }

  // Fonts have to be resident before the first fillText, or the card is set in whatever the
  // browser had lying around. The screenshot path waits for the same thing.
  if (document.fonts?.ready) await document.fonts.ready;

  // Keep three.js out of the initial chunk; saving loads the same renderer as the stage.
  const { renderSpatialCard } = await import('./render-card');
  return renderSpatialCard(subject, scale);
}
