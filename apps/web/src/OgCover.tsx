import { useEffect, useRef } from 'react';
import { GALLERY } from './features/gallery';
import { generateScore } from './music/generate';
import { clipWindow } from './music/clip';
import { barToTick, scoreDurationSeconds } from './music/score';
import { ticksAtSeconds } from './visuals/clock';
import { drawField } from './visuals/draw';
import { fieldFor } from './visuals/layout';
import { palettesFor } from './visuals/palette';
import { OG_HEIGHT, OG_WIDTH } from './OgCard';

/**
 * The card a link unfurls with when it is not about one repository.
 *
 * The eight gallery repositories at once, in the order the landing page puts them — smallest
 * first, which is slowest first. It is the page, as a picture. The alternative was a wordmark
 * on a coloured ground, and that would have been a logo: true of any project, and evidence of
 * nothing. Eight different-looking repositories is the entire claim this project makes, and
 * it is the one thing that cannot be faked by a designer who has not built it.
 *
 * Every tile is drawn by the same drawField as the page, at the same frame the individual
 * cards use, so this is not an illustration of the site — it is eight small copies of it.
 */
const COLUMNS = 4;
const ROWS = 2;
const GAP = 14;
const MARGIN = 40;
const CAPTION = 92;

export function OgCover() {
  const ref = useRef<HTMLDivElement | null>(null);
  const palettes = palettesFor(GALLERY.map((entry) => entry.seed));

  const tileWidth = (OG_WIDTH - MARGIN * 2 - GAP * (COLUMNS - 1)) / COLUMNS;
  const tileHeight = (OG_HEIGHT - MARGIN * 2 - CAPTION - GAP * (ROWS - 1)) / ROWS;

  useEffect(() => {
    const host = ref.current;
    if (!host) return;

    GALLERY.forEach((features, index) => {
      const canvas = host.querySelector<HTMLCanvasElement>(`canvas[data-tile="${index}"]`);
      const context = canvas?.getContext('2d');
      if (!canvas || !context) return;

      const score = generateScore(features);
      const clip = clipWindow(score);
      const totalTicks = barToTick(score.bars);

      drawField(
        context,
        tileWidth,
        tileHeight,
        {
          columns: fieldFor(features),
          palette: palettes[index]!,
          fileCount: features.timeline.length,
          durationSeconds: scoreDurationSeconds(score),
          totalTicks,
        },
        {
          tick: ticksAtSeconds(clip.startSeconds + clip.durationSeconds, score.bpm, totalTicks),
          onsets: [],
          delta: 0,
        },
        new Map(),
      );

      canvas.dataset['ready'] = 'true';
    });
  }, [palettes, tileHeight, tileWidth]);

  return (
    <div
      ref={ref}
      style={{
        width: OG_WIDTH,
        height: OG_HEIGHT,
        padding: MARGIN,
        boxSizing: 'border-box',
        background: '#f2f3f5',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        color: '#16181c',
      }}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${COLUMNS}, ${tileWidth}px)`,
          gap: GAP,
        }}
      >
        {GALLERY.map((features, index) => (
          <canvas
            key={features.seed}
            data-tile={index}
            data-og-canvas
            width={tileWidth}
            height={tileHeight}
            style={{ width: tileWidth, height: tileHeight, borderRadius: 4 }}
          />
        ))}
      </div>
      <div style={{ marginTop: 34, display: 'flex', alignItems: 'baseline', gap: 22 }}>
        <div style={{ fontSize: 34, fontWeight: 500, letterSpacing: '-0.01em' }}>Codetta</div>
        <div style={{ fontSize: 19, opacity: 0.62 }}>
          Paste a GitHub repository. Hear what it sounds like.
        </div>
      </div>
    </div>
  );
}
