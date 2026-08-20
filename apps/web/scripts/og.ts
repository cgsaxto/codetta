import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

/**
 * Screenshot the share card for every gallery repository, plus a manifest of what each link
 * should say when it unfurls.
 *
 * A real browser rather than a canvas library, and the site's own code rather than a second
 * implementation. The alternative considered was porting the drawing to Go — 179 lines
 * including the seeded PRNG that decides every repository's key — and the cost was never the
 * porting. It was that two implementations of a deterministic picture have to agree forever,
 * and drift would show up as an unfurl whose colours are slightly wrong, which nobody would
 * notice without putting the two side by side.
 *
 * The manifest exists so `apps/api` can serve per-repository meta tags without knowing what a
 * key or a tempo is. It reads strings someone else generated, exactly as it serves documents
 * someone else parsed.
 *
 *   pnpm --filter @codetta/web og      # with the dev server already running
 */

const BASE = process.env['OG_BASE'] ?? 'http://localhost:5174';
const OUT = new URL('../public/og/', import.meta.url).pathname;

interface Entry {
  owner: string;
  name: string;
  title: string;
  description: string;
  image: string;
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });

  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1200, height: 630 },
    // Twice the pixels, so the card is sharp on the retina screen most timelines are read on.
    deviceScaleFactor: 2,
  });

  // Pulled from the running app rather than re-derived here, so the manifest cannot describe
  // a piece the site does not play.
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  const repos = await page.evaluate(async () => {
    const gallery = await import('/src/features/gallery.ts');
    const music = await import('/src/music/generate.ts');
    return gallery.GALLERY.map((entry) => {
      const score = music.generateScore(entry);
      const mode = score.mode.charAt(0).toUpperCase() + score.mode.slice(1);
      return {
        owner: entry.repo.owner,
        name: entry.repo.name,
        language: entry.repo.primaryLanguage,
        lines: entry.totals.linesOfCode,
        key: `${score.root} ${mode}`,
        bpm: score.bpm,
      };
    });
  });

  // The fallback first, so a failure here is visible before eight slower captures rather
  // than after them.
  await page.goto(`${BASE}/?og=cover`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => {
    const canvases = document.querySelectorAll('canvas[data-og-canvas]');
    return (
      canvases.length > 0 &&
      [...canvases].every((canvas) => (canvas as HTMLCanvasElement).dataset['ready'] === 'true')
    );
  });
  await page.screenshot({ path: `${OUT}cover.png` });
  process.stdout.write('cover\n');

  const manifest: Entry[] = [];

  for (const repo of repos) {
    const slug = `${repo.owner}-${repo.name}`.toLowerCase();
    const file = `${slug}.png`;

    await page.goto(`${BASE}/?og=${repo.owner}/${repo.name}`, { waitUntil: 'networkidle' });
    // The canvas sets this once its paint has landed. Waiting on a selector rather than a
    // timeout, so a slow machine produces the same image as a fast one instead of a blank.
    await page.waitForSelector('canvas[data-og-canvas][data-ready="true"]');
    await page.screenshot({ path: `${OUT}${file}` });

    manifest.push({
      owner: repo.owner,
      name: repo.name,
      title: `${repo.owner}/${repo.name} — Codetta`,
      description: `${repo.language}, ${repo.lines.toLocaleString('en-US')} lines, played as ${repo.key} at ${repo.bpm} BPM.`,
      image: `/og/${file}`,
    });

    process.stdout.write(`${slug}\n`);
  }

  await browser.close();
  await writeFile(`${OUT}manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
}

await main();
