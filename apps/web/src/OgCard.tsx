import { useEffect, useRef } from 'react';
import type { RepoFeatures } from '@codetta/schema';
import { generateScore } from './music/generate';
import { CARD_HEIGHT, CARD_WIDTH, drawCard } from './visuals/card';
import { palettesFor } from './visuals/palette';
import { GALLERY } from './features/gallery';

/**
 * The picture a shared link unfurls with — the card, screenshotted at build time.
 *
 * A real browser rather than a canvas library, and the site's own `drawCard` rather than a
 * second implementation. The alternative was porting the drawing to Go, and the cost was
 * never the porting: it was that two implementations of a deterministic picture have to
 * agree forever, and drift would show up as an unfurl whose colours are slightly wrong,
 * invisible in review because each looks right on its own. See scripts/og.ts.
 *
 * This component is now only a canvas and a size. Everything on it is drawn by the same
 * function a visitor's downloaded card goes through.
 */

export function OgCard({ features }: { features: RepoFeatures }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Resolved against the whole gallery, so the eight cards are as far apart in colour as the
  // eight tiles are. A card drawn from the repository alone could sit next to its neighbour
  // in someone's timeline wearing nearly the same hue.
  const seeds = GALLERY.map((entry) => entry.seed);
  const index = seeds.indexOf(features.seed);
  const palette = palettesFor(index >= 0 ? seeds : [...seeds, features.seed])[
    index >= 0 ? index : seeds.length
  ]!;

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;

    // Awaited before drawing, or the card is set in whatever font was resident when the
    // effect ran — which on a cold load is not the one the rest of the site uses.
    void document.fonts.ready.then(() => {
      drawCard(context, CARD_WIDTH, CARD_HEIGHT, {
        features,
        score: generateScore(features),
        palette,
      });
      // Read by the screenshot script, so it never captures a frame before the paint lands.
      canvas.dataset['ready'] = 'true';
    });
  }, [features, palette]);

  return (
    <div style={{ width: CARD_WIDTH, height: CARD_HEIGHT, background: palette.ground }}>
      <canvas ref={canvasRef} width={CARD_WIDTH} height={CARD_HEIGHT} data-og-canvas />
    </div>
  );
}
