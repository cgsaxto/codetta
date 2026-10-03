import { describe, expect, it } from 'vitest';
import { GALLERY, GALLERY_BY_SIZE } from '../features/gallery';
import { generateScore } from '../music/generate';
import { barToTick } from '../music/score';
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  cardCaption,
  cardFilename,
  cardPalette,
  cardTick,
  drawCardOverlay,
  fitCardTitle,
} from './card';
import { paletteFor, palettesFor } from './palette';
import { SCENE_BACKGROUND } from './spatial';

/**
 * There is no canvas here, so the context is a recorder: every call is kept and nothing is
 * painted. That is enough for the two things about this picture that have actually been
 * wrong — which frame it draws, and whether the face and the name are on top of each other.
 * Whether it looks good is a question for a person, and only for a person.
 */

interface Call {
  method: string;
  args: unknown[];
}

function recorder() {
  const calls: Call[] = [];
  const known: Record<string, unknown> = {
    measureText: (text: string) => ({ width: text.length * 8 }),
    // The two calls whose return value is used rather than dropped.
    createLinearGradient: () => ({ addColorStop: () => {} }),
  };

  const context = new Proxy(known, {
    get(target, key) {
      if (key in target) return target[key as string];
      return (...args: unknown[]) => {
        calls.push({ method: String(key), args });
      };
    },
    set() {
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;

  const texts = () => calls.filter((call) => call.method === 'fillText');
  return { context, calls, texts };
}

const features = GALLERY[0]!;
const score = generateScore(features);
const palette = paletteFor(features.seed);

describe('cardTick', () => {
  it('is the clip’s last frame, which is the only frame the card is a still of', () => {
    // Tick 0 was the first answer and it was wrong in a way no test could see: every drawing
    // call still happens and the result is a dark rectangle, because the legibility of this
    // picture is entirely the contrast between the part of the repository that has been read
    // and the part that has not.
    const tick = cardTick(score);
    expect(tick).toBeGreaterThan(0);
    expect(tick).toBeLessThanOrEqual(barToTick(score.bars));

    // Past the peak, where the clip ends — not somewhere in the intro.
    const peak = score.sections.find((section) => section.name === 'peak')!;
    expect(tick).toBeGreaterThan(barToTick(peak.startBar));
  });
});

function drawOverlay(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  subject: Parameters<typeof drawCardOverlay>[3],
) {
  drawCardOverlay(context, width, height, subject, SCENE_BACKGROUND);
}

describe('drawCardOverlay', () => {
  it('puts the repository’s name and what it sounds like on the card', () => {
    const { context, texts } = recorder();
    drawOverlay(context, CARD_WIDTH, CARD_HEIGHT, { features, score, palette });

    const written = texts()
      .map((call) => String(call.args[0]))
      .join('');
    expect(written).toContain(`${features.repo.owner}/${features.repo.name}`);
    expect(written).toContain(String(score.bpm));
    // Set a character at a time, because context.letterSpacing is missing from enough
    // browsers that a visitor on the wrong one would get a differently-set wordmark.
    expect(written).toContain('CODETTA');
  });

  it('draws the scrim before the text, so nothing is painted over', () => {
    const { context, calls } = recorder();
    drawOverlay(context, CARD_WIDTH, CARD_HEIGHT, { features, score, palette });

    const methods = calls.map((call) => call.method);
    const lastRect = methods.lastIndexOf('fillRect');
    const firstText = methods.indexOf('fillText');
    expect(lastRect).toBeLessThan(firstText);
  });

  it('moves the text aside for a face rather than under it', () => {
    const { context: bare, texts: bareTexts } = recorder();
    drawOverlay(bare, CARD_WIDTH, CARD_HEIGHT, { features, score, palette });

    const { context, texts, calls } = recorder();
    drawOverlay(context, CARD_WIDTH, CARD_HEIGHT, {
      features,
      score,
      palette,
      avatar: {} as CanvasImageSource,
    });

    expect(calls.some((call) => call.method === 'drawImage')).toBe(true);
    expect(Number(texts()[0]?.args[1])).toBeGreaterThan(Number(bareTexts()[0]?.args[1]));
  });

  it('scales with the surface it is given', () => {
    // Drawn at twice the size for a retina timeline, and the layout has to come with it.
    const { context: small, texts: smallTexts } = recorder();
    drawOverlay(small, CARD_WIDTH, CARD_HEIGHT, { features, score, palette });

    const { context: large, texts: largeTexts } = recorder();
    drawOverlay(large, CARD_WIDTH * 2, CARD_HEIGHT * 2, { features, score, palette });

    expect(Number(largeTexts()[0]?.args[1])).toBeCloseTo(
      Number(smallTexts()[0]?.args[1]) * 2,
      5,
    );
  });
});

describe('cardCaption', () => {
  it('says what the piece is in the terms the rest of the site uses', () => {
    const caption = cardCaption(features, score);
    expect(caption).toContain(features.repo.primaryLanguage);
    expect(caption).toContain(score.root);
    expect(caption).toContain(`${score.bpm} BPM`);
  });
});

describe('cardFilename', () => {
  it('is lowercase, like the other artifacts', () => {
    expect(cardFilename('PSF', 'Requests')).toBe('codetta-psf-requests-card.png');
  });
});

describe('cardPalette', () => {
  it('gives every gallery card the colour its tile wears on the page', () => {
    // The page resolves the gallery smallest first. The cards used to resolve it in the order
    // the files are listed, and palettesFor lays colours around the wheel in the order it is
    // handed seeds — so all eight cards wore a colour the site never showed.
    const onPage = palettesFor(GALLERY_BY_SIZE.map((entry) => entry.seed));
    GALLERY_BY_SIZE.forEach((entry, index) => {
      expect(cardPalette(entry), entry.repo.name).toStrictEqual(onPage[index]);
    });
  });

  it('resolves a repository outside the gallery the way the page resolves a loaded one', () => {
    const loaded = { ...features, seed: 'feedbeef' };
    const onPage = palettesFor([...GALLERY_BY_SIZE.map((entry) => entry.seed), loaded.seed]);
    expect(cardPalette(loaded)).toStrictEqual(onPage[GALLERY_BY_SIZE.length]);
  });
});

describe('fitCardTitle', () => {
  // A stand-in for measureText: a monospaced face at 0.6em per character, which is close to
  // what the real stack measures. The function itself assumes nothing about the font.
  const measure = (text: string, size: number) => Array.from(text).length * size * 0.6;
  const room = 1088; // The card's width less its two margins.

  it('leaves a short name alone at full size', () => {
    expect(fitCardTitle('facebook', 'react', room, measure)).toStrictEqual({
      text: 'facebook/react',
      size: 46,
    });
  });

  it('shrinks before it cuts, because a whole name small beats a cut one large', () => {
    const fitted = fitCardTitle(
      'kubernetes-sigs',
      'aws-load-balancer-controller',
      room,
      measure,
    );
    expect(fitted.text).toBe('kubernetes-sigs/aws-load-balancer-controller');
    expect(fitted.size).toBeLessThan(46);
    expect(fitted.size).toBeGreaterThanOrEqual(32);
    expect(measure(fitted.text, fitted.size)).toBeLessThanOrEqual(room);
  });

  it('cuts the middle of the name and keeps the owner, the slash and both ends', () => {
    const name = 'an-extremely-long-repository-name-that-keeps-going-and-going-until-the-end';
    const fitted = fitCardTitle('some-organisation', name, room, measure);

    expect(fitted.size).toBe(32);
    expect(fitted.text.startsWith('some-organisation/an-')).toBe(true);
    expect(fitted.text.endsWith('-the-end')).toBe(true);
    expect(fitted.text).toContain('…');
    expect(measure(fitted.text, fitted.size)).toBeLessThanOrEqual(room);
  });

  it('never overflows, whatever it is given and however little room there is', () => {
    // Including the widths a card with an avatar leaves, and ones no card would ever have.
    const owners = ['a', 'facebook', 'a'.repeat(39)];
    const names = ['b', 'react', 'x'.repeat(40), 'y'.repeat(100)];
    for (const owner of owners) {
      for (const name of names) {
        for (const width of [1088, 958, 400, 120, 30]) {
          const fitted = fitCardTitle(owner, name, width, measure);
          expect(
            measure(fitted.text, fitted.size),
            `${owner}/${name} in ${width}`,
          ).toBeLessThanOrEqual(Math.max(width, measure('…', 32)));
          expect(fitted.text.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('gives up the owner only when the owner alone leaves no room for a name', () => {
    const fitted = fitCardTitle('o'.repeat(39), 'n'.repeat(60), 400, measure);
    expect(fitted.text).toContain('…');
    expect(fitted.text.startsWith('o'.repeat(39))).toBe(false);
    expect(measure(fitted.text, fitted.size)).toBeLessThanOrEqual(400);
  });
});
