import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { RepoFeatures } from '@codetta/schema';
import { generateScore } from './music/generate';
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  cardPalette,
  cardTick,
  drawCardOverlay,
} from './visuals/card';
import { SpatialField } from './visuals/SpatialField';
import { SCENE_BACKGROUND } from './visuals/spatial';

/**
 * The picture a shared link unfurls with — the page's own 3D scene, screenshotted at build
 * time, wearing the card's text.
 *
 * Two layers, and each is the one the site already has rather than a copy of it. Underneath,
 * SpatialField, at a fixed position in the piece. On top, a transparent canvas drawn by
 * `drawCardOverlay`, the same function that sets the text on a visitor's downloaded card. The
 * alternative for the picture was a still drawn some other way, and a still that is not the
 * scene is an unfurl showing a product the link does not lead to.
 *
 * The frame is `cardTick`: the last one of the clip, the thirty seconds from the peak that the
 * WAV and the video are cut from. The scene is a function of that one number, so the card is
 * the same picture on every build and on every machine.
 */

export function OgCard({ features }: { features: RepoFeatures }) {
  const root = useRef<HTMLDivElement | null>(null);
  const overlay = useRef<HTMLCanvasElement | null>(null);
  const sceneReady = useRef(false);
  const textReady = useRef(false);

  // The colour of this repository's tile on the page — see cardPalette for why that is not
  // the same thing as resolving the gallery in any order that happens to be to hand.
  const palette = useMemo(() => cardPalette(features), [features]);

  const score = useMemo(() => generateScore(features), [features]);
  const tick = useMemo(() => cardTick(score), [score]);
  const position = useCallback(() => tick, [tick]);

  // Every pixel the screenshot has. Capped on the page for speed; here it is the whole point.
  const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;

  /** Tells the screenshot script to shoot, once both layers have landed and not before. */
  const settle = useCallback(() => {
    if (sceneReady.current && textReady.current && root.current) {
      root.current.dataset['ogReady'] = 'true';
    }
  }, []);

  useEffect(() => {
    const canvas = overlay.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;

    // Awaited before drawing, or the card is set in whatever font was resident when the
    // effect ran — which on a cold load is not the one the rest of the site uses.
    void document.fonts.ready.then(() => {
      context.clearRect(0, 0, canvas.width, canvas.height);
      drawCardOverlay(
        context,
        canvas.width,
        canvas.height,
        { features, score, palette },
        SCENE_BACKGROUND,
      );
      textReady.current = true;
      settle();
    });
  }, [features, palette, score, settle]);

  const onReady = useCallback(() => {
    sceneReady.current = true;
    settle();
  }, [settle]);

  return (
    <div
      ref={root}
      style={{
        position: 'relative',
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
        overflow: 'hidden',
        background: SCENE_BACKGROUND,
      }}
    >
      <div style={{ position: 'absolute', inset: 0 }}>
        <SpatialField
          features={features}
          score={score}
          palette={palette}
          mode="pillars"
          position={position}
          frameloop="demand"
          dpr={dpr}
          onReady={onReady}
        />
      </div>
      <canvas
        ref={overlay}
        width={Math.round(CARD_WIDTH * dpr)}
        height={Math.round(CARD_HEIGHT * dpr)}
        style={{
          position: 'absolute',
          inset: 0,
          width: CARD_WIDTH,
          height: CARD_HEIGHT,
          pointerEvents: 'none',
        }}
      />
    </div>
  );
}
