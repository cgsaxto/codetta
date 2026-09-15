import { useCallback, useMemo, useRef } from 'react';
import { GALLERY_BY_SIZE } from './features/gallery';
import { generateScore } from './music/generate';
import { CARD_HEIGHT, CARD_WIDTH, cardPalette, cardTick } from './visuals/card';
import type { Palette } from './visuals/palette';
import { SpatialField } from './visuals/SpatialField';
import { SCENE_BACKGROUND } from './visuals/spatial';

/**
 * The card a link unfurls with when it is not about one repository.
 *
 * The eight gallery repositories at once, smallest first, each the page's own 3D scene at the
 * frame its own card uses. The alternative was a wordmark on a coloured ground, and that would
 * have been a logo: true of any project, and evidence of nothing. Eight different-looking
 * repositories is the entire claim this project makes, and it is the one thing that cannot be
 * faked by a designer who has not built it.
 *
 * Eight WebGL contexts on one page, which is heavy for a page and irrelevant for a screenshot
 * taken once at build time — browsers allow sixteen before they start dropping the oldest.
 */
const COLUMNS = 4;
const ROWS = 2;
const GAP = 12;
const MARGIN = 36;
const CAPTION = 88;

function Tile({
  index,
  palette,
  onReady,
}: {
  index: number;
  palette: Palette;
  onReady: (index: number) => void;
}) {
  const features = GALLERY_BY_SIZE[index]!;
  const score = useMemo(() => generateScore(features), [features]);
  const tick = useMemo(() => cardTick(score), [score]);
  const position = useCallback(() => tick, [tick]);
  const ready = useCallback(() => onReady(index), [index, onReady]);
  const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;

  return (
    <div
      style={{
        position: 'relative',
        overflow: 'hidden',
        borderRadius: 8,
        border: '1px solid rgb(255 255 255 / 10%)',
        background: SCENE_BACKGROUND,
      }}
    >
      <SpatialField
        features={features}
        score={score}
        palette={palette}
        mode="pillars"
        position={position}
        frameloop="demand"
        dpr={dpr}
        onReady={ready}
      />
      <div
        style={{
          position: 'absolute',
          left: 12,
          bottom: 10,
          fontSize: 13,
          color: palette.modules[0],
          textShadow: `0 0 12px ${SCENE_BACKGROUND}`,
        }}
      >
        {features.repo.name}
      </div>
    </div>
  );
}

export function OgCover() {
  const root = useRef<HTMLDivElement | null>(null);
  const ready = useRef(new Set<number>());
  // Each tile in the colour it wears on the page, in the order the page shows them.
  const palettes = useMemo(() => GALLERY_BY_SIZE.map((entry) => cardPalette(entry)), []);

  const onTileReady = useCallback((index: number) => {
    ready.current.add(index);
    if (ready.current.size === GALLERY_BY_SIZE.length && root.current) {
      root.current.dataset['ogReady'] = 'true';
    }
  }, []);

  const tileHeight = (CARD_HEIGHT - MARGIN * 2 - CAPTION - GAP * (ROWS - 1)) / ROWS;

  return (
    <div
      ref={root}
      style={{
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
        padding: MARGIN,
        boxSizing: 'border-box',
        background: '#04060a',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        color: '#ffffff',
      }}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${COLUMNS}, 1fr)`,
          gridAutoRows: tileHeight,
          gap: GAP,
        }}
      >
        {GALLERY_BY_SIZE.map((entry, index) => (
          <Tile
            key={entry.seed}
            index={index}
            palette={palettes[index]!}
            onReady={onTileReady}
          />
        ))}
      </div>
      <div style={{ marginTop: 30, display: 'flex', alignItems: 'baseline', gap: 22 }}>
        <div style={{ fontSize: 15, letterSpacing: '0.34em', textTransform: 'uppercase' }}>
          Codetta
        </div>
        <div style={{ fontSize: 18, color: 'rgb(255 255 255 / 62%)' }}>
          Paste a GitHub repository. Hear what it sounds like.
        </div>
      </div>
    </div>
  );
}
