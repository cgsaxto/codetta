import { describe, expect, it } from 'vitest';
import { GALLERY } from '../features/gallery';
import { generateScore } from '../music/generate';
import { barToTick } from '../music/score';
import { CARD_HEIGHT, CARD_WIDTH, cardCaption, cardFilename, cardTick, drawCard } from './card';
import { paletteFor } from './palette';

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

describe('drawCard', () => {
  it('puts the repository’s name and what it sounds like on the card', () => {
    const { context, texts } = recorder();
    drawCard(context, CARD_WIDTH, CARD_HEIGHT, { features, score, palette });

    const written = texts()
      .map((call) => String(call.args[0]))
      .join('');
    expect(written).toContain(`${features.repo.owner}/${features.repo.name}`);
    expect(written).toContain(String(score.bpm));
    // Set a character at a time, because context.letterSpacing is missing from enough
    // browsers that a visitor on the wrong one would get a differently-set wordmark.
    expect(written).toContain('CODETTA');
  });

  it('draws the field before the text, so nothing is painted over', () => {
    const { context, calls } = recorder();
    drawCard(context, CARD_WIDTH, CARD_HEIGHT, { features, score, palette });

    const methods = calls.map((call) => call.method);
    const lastRect = methods.lastIndexOf('fillRect');
    const firstText = methods.indexOf('fillText');
    expect(lastRect).toBeLessThan(firstText);
  });

  it('moves the text aside for a face rather than under it', () => {
    const { context: bare, texts: bareTexts } = recorder();
    drawCard(bare, CARD_WIDTH, CARD_HEIGHT, { features, score, palette });

    const { context, texts, calls } = recorder();
    drawCard(context, CARD_WIDTH, CARD_HEIGHT, {
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
    drawCard(small, CARD_WIDTH, CARD_HEIGHT, { features, score, palette });

    const { context: large, texts: largeTexts } = recorder();
    drawCard(large, CARD_WIDTH * 2, CARD_HEIGHT * 2, { features, score, palette });

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
