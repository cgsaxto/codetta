import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RepoFeatures } from '@codetta/schema';
import type * as AudioPlayer from './audio/player';
import type { Player } from './audio/player';
import { ApiError, fetchFeatures, parseTarget, type RepoRef } from './features/api';
import { fetchUserPick, pickSummary, type UserPick } from './features/user';
import { GALLERY } from './features/gallery';
import { pathForRepo, repoFromPath } from './features/route';
import { generateScore } from './music/generate';
import { barToTick, type Score } from './music/score';
import { cardFilename, loadAvatar, renderCard, shortLines } from './visuals/card';
import { ticksAtSeconds } from './visuals/clock';
import { palettesFor, type Palette } from './visuals/palette';
import { recordClip, supportedVideoType, videoFilename, type Shape } from './visuals/record';
import type { SpectrumBands, ViewMode } from './visuals/SpatialField';

const SpatialField = memo(
  lazy(() =>
    import('./visuals/SpatialField').then((module) => ({ default: module.SpatialField })),
  ),
);

const EMPTY_SPECTRUM: SpectrumBands = { low: 0, mid: 0, high: 0, energy: 0, progress: 0 };
const SPECTRUM_KEYS = ['low', 'mid', 'high'] as const;

let audioModulePromise: Promise<typeof AudioPlayer> | null = null;

/** Load Tone only when an audio action is imminent; hovering the main control hides the wait. */
function audioModule() {
  audioModulePromise ??= import('./audio/player');
  return audioModulePromise;
}

/**
 * The gallery is the page.
 *
 * Not a headline with examples underneath: eight repositories, drawn, in a grid, and one
 * click plays any of them. The largest type on the page is fifteen pixels, which is the one
 * real risk here — the eight pictures are the headline, and if they cannot carry it then no
 * sentence above them would have either.
 *
 * The page itself contributes no colour. Every hue on screen comes from a commit sha, which
 * is the whole claim of the project, and a dark page would have merged the tiles into it and
 * spent the contrast that makes eight repositories look like eight repositories.
 *
 * Ordered by size, smallest first, because size is what sets tempo: reading the grid left to
 * right is reading it slowest to fastest. The order encodes something true rather than
 * decorating, which is the only reason to impose one.
 */

/** Seconds of playback after which someone has heard enough to be offered the input. */
const HEARD_AFTER = 20;

interface TileProps {
  features: RepoFeatures;
  score: Score;
  palette: Palette;
  playing: boolean;
  selected: boolean;
  onToggle: () => void;
}

function Tile({ features, score, palette, playing, selected, onToggle }: TileProps) {
  const accent = palette.modules[0] ?? '#888';
  const { repo } = features;

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={playing}
      aria-current={selected ? 'true' : undefined}
      title={`${repo.owner}/${repo.name}`}
      className="group min-w-[190px] flex-1 rounded-2xl border px-4 py-3 text-left transition duration-300"
      style={{
        borderColor: selected ? `${accent}70` : 'var(--border-quiet)',
        background: selected ? `${accent}12` : 'var(--surface-tile)',
        ['--focus-ring' as string]: accent,
      }}
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className={`size-1.5 shrink-0 rounded-full ${playing ? 'animate-pulse' : ''}`}
          style={{ background: accent, opacity: playing || selected ? 1 : 0.38 }}
        />
        <span className="truncate text-[13px] leading-none font-medium text-white">
          {repo.name}
        </span>
        <span className="text-ui-muted ml-auto text-[9px] tracking-[0.14em] uppercase">
          {playing ? 'live' : score.bpm}
        </span>
      </div>
      <div className="text-ui-muted mt-2 text-[9px] tracking-[0.14em] uppercase">
        {repo.owner} / {repo.primaryLanguage} / {shortLines(features.totals.linesOfCode)}
      </div>
    </button>
  );
}

export default function App() {
  const [player, setPlayer] = useState<Player | null>(null);
  const [playingSha, setPlayingSha] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const [heard, setHeard] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('pillars');

  const [saving, setSaving] = useState<'clip' | 'full' | 'card' | Shape | null>(null);
  const [recorded, setRecorded] = useState(0);
  /** The tile a shared link named, so arriving on one lands on it rather than on the grid. */
  const [focusSha, setFocusSha] = useState<string | null>(null);
  const [custom, setCustom] = useState<RepoFeatures | null>(null);
  /** The account a username resolved to, when that is how the visitor got here. */
  const [pick, setPick] = useState<UserPick | null>(null);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState<'user' | 'repo' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pending = useRef<AbortController | null>(null);
  const heardTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputSection = useRef<HTMLElement | null>(null);
  const stage = useRef<HTMLElement | null>(null);

  // Smallest first, so the grid reads slowest to fastest. A repository the visitor loaded
  // goes last, where it is the newest thing rather than buried among the eight.
  const entries = useMemo(() => {
    const ordered = [...GALLERY].sort((a, b) => a.totals.linesOfCode - b.totals.linesOfCode);
    return custom ? [...ordered, custom] : ordered;
  }, [custom]);

  const playing = useMemo(
    () => entries.find((entry) => entry.repo.commitSha === playingSha) ?? null,
    [entries, playingSha],
  );

  const active = useMemo(
    () => entries.find((entry) => entry.repo.commitSha === focusSha) ?? playing ?? entries[0]!,
    [entries, focusSha, playing],
  );

  const scores = useMemo(
    () => new Map(entries.map((entry) => [entry.repo.commitSha, generateScore(entry)])),
    [entries],
  );

  // Resolved across the whole set rather than one repository at a time: eight independent
  // draws from a hue circle clump, and the gallery's entire claim is that each one looks
  // like itself.
  const palettes = useMemo(() => {
    const resolved = palettesFor(entries.map((entry) => entry.seed));
    return new Map(entries.map((entry, at) => [entry.repo.commitSha, resolved[at]!]));
  }, [entries]);

  /**
   * Bring the input into view when it appears.
   *
   * It was revealed correctly and nobody could tell: in a 536px window its top sits around
   * 740px down the page, so it arrived a couple of hundred pixels below the fold and the
   * visitor had no reason to scroll and find out. A reveal nobody sees is the same as no
   * reveal, and the fix belongs here rather than in the timing, which was right.
   *
   * Only when it is actually off-screen, and instantly rather than smoothly for anyone who
   * has asked for less motion.
   */
  useEffect(() => {
    const section = inputSection.current;
    if (!heard || !section) return;

    const box = section.getBoundingClientRect();
    if (box.top < window.innerHeight - 40) return;

    const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    section.scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'end' });
  }, [heard]);

  useEffect(() => () => player?.stop(), [player]);
  useEffect(
    () => () => {
      pending.current?.abort();
      if (heardTimer.current) clearTimeout(heardTimer.current);
    },
    [],
  );

  function stop() {
    player?.stop();
    setPlayer(null);
    setPlayingSha(null);
  }

  /**
   * Play whatever the address names, on arrival and on back or forward.
   *
   * A shared link has to land on the thing it promised. Autoplay will be refused without a
   * gesture in most browsers, so this loads and selects the repository and leaves pressing
   * play to the visitor — the tile is there, drawn in its own colours, which is the promise
   * kept even when the sound cannot start by itself.
   */
  useEffect(() => {
    const open = () => {
      const wanted = repoFromPath(window.location.pathname);
      if (!wanted) return;

      const already = GALLERY.find(
        (entry) =>
          entry.repo.owner.toLowerCase() === wanted.owner.toLowerCase() &&
          entry.repo.name.toLowerCase() === wanted.name.toLowerCase(),
      );
      // Never through `custom` for one of the eight: that list is appended to the gallery,
      // so a repository already in it would appear twice.
      if (already) {
        setFocusSha(already.repo.commitSha);
        return;
      }
      // Without autoplay. Browsers refuse to start audio without a gesture, and a link that
      // appears to fail is worse than one that asks for a click.
      void load(`${wanted.owner}/${wanted.name}`, false);
    };

    open();
    window.addEventListener('popstate', open);
    return () => window.removeEventListener('popstate', open);
    // Once, on mount, plus whenever the visitor moves through their own history.
  }, []);

  async function play(entry: RepoFeatures) {
    const sha = entry.repo.commitSha;
    setFocusSha(sha);
    if (playingSha === sha) {
      // Stopping counts as having heard it: nobody stops a piece they have not listened to.
      setHeard(true);
      stop();
      return;
    }

    stop();
    setStarting(sha);
    try {
      // Generated here when absent rather than looked up only: a repository the visitor just
      // loaded is not in `scores` yet, because that memo is derived from state set in the
      // same tick. Looking it up alone made the load succeed and then play nothing.
      const score = scores.get(sha) ?? generateScore(entry);
      const { startPlayback } = await audioModule();
      setPlayer(await startPlayback(score));
      setPlayingSha(sha);
      setError(null);
      // Replaced rather than pushed. The gallery never leaves the screen, so playing a
      // repository is not navigation — this is a label for what is sounding, and eight tiles
      // sampled in a row would otherwise leave eight entries to press back through.
      history.replaceState(null, '', pathForRepo(entry.repo.owner, entry.repo.name));
      // Not audio timing — the transport owns that. This only decides when to offer the
      // input, and offering it before the visitor has heard anything is the thing the
      // roadmap is explicit about avoiding.
      // Started once and never restarted. Resetting it on every tile meant someone sampling
      // eight of them for fifteen seconds each would have heard plenty and still be shown
      // nothing.
      if (!heard && !heardTimer.current) {
        heardTimer.current = setTimeout(() => setHeard(true), HEARD_AFTER * 1000);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setStarting(null);
    }
  }

  /**
   * Render the piece that is playing to a file.
   *
   * Offered only while something is playing, because the thing being saved is the thing being
   * heard — a download button on a tile nobody has listened to is asking someone to take a
   * file on trust.
   */
  async function save(entry: RepoFeatures, clip: boolean) {
    const sha = entry.repo.commitSha;
    const score = scores.get(sha) ?? generateScore(entry);

    setSaving(clip ? 'clip' : 'full');
    setError(null);
    try {
      const { renderWav, wavFilename } = await audioModule();
      const blob = await renderWav(score, { clip });
      offer(blob, wavFilename(score, entry.repo.owner, entry.repo.name, clip));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(null);
    }
  }

  /** Hand a blob to the browser as a download. */
  function offer(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    // Released on the next tick rather than immediately: revoking before the browser has
    // taken the URL cancels the download in some of them.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /**
   * Record the clip as a video, which takes the thirty seconds it lasts.
   *
   * The audio is rendered offline first and played into the recording, so the sound in the
   * video is the sound in the WAV rather than a second performance that resembles it.
   */
  async function record(entry: RepoFeatures, shape: Shape) {
    const sha = entry.repo.commitSha;
    const score = scores.get(sha) ?? generateScore(entry);
    const type = supportedVideoType();
    if (!type) {
      setError('This browser cannot record video. The audio download still works.');
      return;
    }

    stop();
    setSaving(shape);
    setRecorded(0);
    setError(null);
    try {
      const { renderClip } = await audioModule();
      const audio = await renderClip(score, { clip: true });
      const blob = await recordClip({
        score,
        features: entry,
        audio,
        shape,
        palette: palettes.get(sha),
        onProgress: setRecorded,
      });
      offer(blob, videoFilename(score, entry.repo.owner, entry.repo.name, shape, type));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(null);
      setRecorded(0);
    }
  }

  /**
   * Save the card: the repository drawn, its name, and — when a username chose it — the face
   * of whoever it belongs to.
   *
   * The same drawing the link previews use, through the same function, so what a visitor
   * downloads is what a timeline shows rather than something that resembles it.
   */
  async function saveCard(entry: RepoFeatures) {
    const sha = entry.repo.commitSha;
    const score = scores.get(sha) ?? generateScore(entry);
    const palette = palettes.get(sha);
    if (!palette) return;

    setSaving('card');
    setError(null);
    try {
      const blob = await renderCard({
        features: entry,
        score,
        palette,
        avatar: await loadAvatar(avatarFor(entry)),
      });
      offer(blob, cardFilename(entry.repo.owner, entry.repo.name));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(null);
    }
  }

  /** The face for a repository, which is only ever the one an account was asked for. */
  function avatarFor(entry: RepoFeatures): string | undefined {
    if (!pick) return undefined;
    const same =
      pick.repo.owner.toLowerCase() === entry.repo.owner.toLowerCase() &&
      pick.repo.name.toLowerCase() === entry.repo.name.toLowerCase();
    return same ? pick.avatar : undefined;
  }

  /**
   * Play whatever the visitor typed — a username or a repository.
   *
   * A username is two requests, deliberately: the first answers "which repository", which is
   * the thing to show immediately, and the second is the slow one. Combining them would leave
   * the page silent through both.
   */
  async function load(text: string, autoplay = true) {
    const target = parseTarget(text);
    if (!target) {
      setError(
        'That does not look like a username or a repository. Try torvalds, or facebook/react.',
      );
      return;
    }

    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;

    stop();
    setPick(null);
    setLoading(target.kind === 'user' ? 'user' : 'repo');
    setError(null);
    try {
      let repo: RepoRef;
      if (target.kind === 'user') {
        const picked = await fetchUserPick(target.login, controller.signal);
        setPick(picked);
        setLoading('repo');
        repo = { owner: picked.repo.owner, name: picked.repo.name };
      } else {
        repo = target.repo;
      }

      const loaded = await fetchFeatures(repo, controller.signal);
      setCustom(loaded);
      setFocusSha(loaded.repo.commitSha);
      if (autoplay) void play(loaded);
    } catch (cause) {
      if (controller.signal.aborted) return;
      setError(cause instanceof ApiError ? cause.message : String(cause));
    } finally {
      if (!controller.signal.aborted) setLoading(null);
    }
  }

  const activeScore = scores.get(active.repo.commitSha) ?? generateScore(active);
  const activePalette = palettes.get(active.repo.commitSha) ?? palettesFor([active.seed])[0]!;
  const activeAccent = activePalette.modules[0] ?? '#8cecff';
  const activeIsPlaying = playingSha === active.repo.commitSha;
  const activePlayer = activeIsPlaying ? player : null;
  const activeTotalTicks = barToTick(activeScore.bars);

  /**
   * The scene's clock, which is the audio transport's.
   *
   * A function rather than a number so that React is not asked to render sixty times a
   * second: the scene calls it once a frame. Null while nothing is playing puts the scene at
   * rest, which is different from tick zero — tick zero is the pad and bass striking.
   */
  const activePosition = useCallback(
    () =>
      activePlayer
        ? ticksAtSeconds(activePlayer.positionSeconds(), activeScore.bpm, activeTotalTicks)
        : null,
    [activePlayer, activeScore.bpm, activeTotalTicks],
  );

  /**
   * The bands change ten times a second, but they do not change application state. Updating
   * the small HUD directly keeps the gallery, score generation and lazy 3D boundary out of
   * React's render path while the geometry itself reads the score every frame.
   */
  const reportSpectrum = useCallback((next: SpectrumBands) => {
    const root = stage.current;
    if (!root) return;

    root.dataset.bandLow = next.low.toFixed(3);
    root.dataset.bandMid = next.mid.toFixed(3);
    root.dataset.bandHigh = next.high.toFixed(3);
    root.dataset.bandEnergy = next.energy.toFixed(3);
    root.style.setProperty('--spectrum-progress', String(next.progress));

    for (const band of SPECTRUM_KEYS) {
      const value = next[band];
      const output = root.querySelector<HTMLElement>(`[data-spectrum-value="${band}"]`);
      if (output) output.textContent = String(Math.round(value * 100));
      root.querySelectorAll<HTMLElement>(`[data-spectrum-bar="${band}"]`).forEach((bar) => {
        const gate = Number(bar.dataset.gate ?? 0);
        bar.style.opacity = String(value >= gate ? 0.9 : 0.13);
      });
    }
  }, []);

  useEffect(() => {
    if (!activeIsPlaying) reportSpectrum(EMPTY_SPECTRUM);
  }, [active.repo.commitSha, activeIsPlaying, reportSpectrum]);

  return (
    <main className="min-h-dvh overflow-hidden bg-[var(--surface-page)] px-3 py-4 font-mono text-white sm:px-6 sm:py-6">
      <div className="mx-auto max-w-[1540px]">
        <header className="mb-4 flex items-center justify-between px-2 sm:mb-5">
          <div className="flex items-center gap-4">
            <h1 className="text-[12px] tracking-[0.34em] uppercase">Codetta</h1>
            <span className="hidden h-3 w-px bg-white/15 sm:block" />
            <p className="text-ui-muted hidden text-[10px] tracking-[0.14em] uppercase sm:block">
              Repository sonification instrument
            </p>
          </div>
          <div className="text-ui-muted flex items-center gap-2 text-[9px] tracking-[0.16em] uppercase">
            <span
              className={`size-1.5 rounded-full ${activeIsPlaying ? 'animate-pulse' : ''}`}
              style={{ background: activeIsPlaying ? activeAccent : 'var(--status-idle)' }}
            />
            {activeIsPlaying ? 'Live' : 'Ready'}
          </div>
        </header>

        <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {starting
            ? `Starting audio for ${active.repo.name}`
            : saving
              ? saving === 'square' || saving === 'vertical'
                ? `Recording ${saving} video, ${Math.round(recorded * 100)} percent complete`
                : `Preparing ${saving}`
              : ''}
        </div>

        <section
          ref={stage}
          className="spatial-stage relative h-[74svh] min-h-[480px] max-h-[680px] overflow-hidden rounded-[26px] border border-white/10 bg-[var(--surface-stage)] shadow-2xl shadow-black/60 sm:h-[calc(100svh-78px)] sm:min-h-[460px] sm:max-h-[820px]"
          style={{
            ['--stage-accent' as string]: activeAccent,
            ['--spectrum-progress' as string]: 0,
          }}
          data-band-low="0.000"
          data-band-mid="0.000"
          data-band-high="0.000"
          data-band-energy="0.000"
        >
          <div className="absolute inset-0">
            <Suspense
              fallback={
                <div className="grid size-full place-items-center">
                  <div className="text-ui-subtle flex items-center gap-2 text-[9px] tracking-[0.2em] uppercase">
                    <span
                      className="size-1.5 animate-pulse rounded-full"
                      style={{ background: activeAccent }}
                    />
                    Initialising space
                  </div>
                </div>
              }
            >
              <SpatialField
                features={active}
                score={activeScore}
                palette={activePalette}
                position={activePosition}
                frameloop={activePlayer ? 'always' : 'demand'}
                mode={viewMode}
                onSpectrum={reportSpectrum}
              />
            </Suspense>
          </div>

          <div className="stage-vignette pointer-events-none absolute inset-0" />
          <div className="stage-top-fade pointer-events-none absolute inset-x-0 top-0 h-40" />

          <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-3 p-4 sm:p-7">
            <div className="min-w-0">
              <p
                className="text-ui-muted max-w-[120px] truncate text-[9px] tracking-[0.14em] uppercase sm:max-w-none sm:tracking-[0.22em]"
                title={`${active.repo.owner} / ${active.repo.primaryLanguage}`}
              >
                {active.repo.owner} / {active.repo.primaryLanguage}
              </p>
              <h2
                className="mt-2 max-w-[108px] truncate text-[24px] leading-none font-light tracking-[-0.04em] sm:max-w-none sm:text-[clamp(24px,4vw,50px)]"
                title={active.repo.name}
              >
                {active.repo.name}
              </h2>
              <p className="text-ui-muted mt-3 text-[9px] tracking-[0.08em] uppercase sm:text-[10px] sm:tracking-[0.14em]">
                {active.repo.commitSha.slice(0, 7)}
                <span className="hidden sm:inline">
                  {' '}
                  · {activeScore.root} {activeScore.mode}
                </span>{' '}
                · {activeScore.bpm} BPM
              </p>
            </div>

            <div className="pointer-events-auto flex shrink-0 rounded-full border border-white/10 bg-black/25 p-1 shadow-lg backdrop-blur-xl">
              {(['pillars', 'nodes'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setViewMode(mode)}
                  aria-pressed={viewMode === mode}
                  className="min-h-11 whitespace-nowrap rounded-full px-2.5 py-2 text-[9px] tracking-[0.1em] uppercase transition sm:px-4 sm:tracking-[0.12em]"
                  style={{
                    color: viewMode === mode ? 'var(--text-primary)' : 'var(--text-secondary)',
                    background: viewMode === mode ? `${activeAccent}22` : 'transparent',
                    boxShadow:
                      viewMode === mode ? `inset 0 0 0 1px ${activeAccent}40` : undefined,
                  }}
                >
                  {mode === 'pillars' ? (
                    'Pillars'
                  ) : (
                    <>
                      <span className="sm:hidden">Nodes</span>
                      <span className="hidden sm:inline">Node sphere</span>
                    </>
                  )}
                </button>
              ))}
            </div>
          </div>

          <div className="pointer-events-none absolute top-1/2 left-5 hidden -translate-y-1/2 sm:block">
            <div className="w-[122px] rounded-2xl border border-white/9 bg-black/18 px-4 py-4 backdrop-blur-xl">
              <p className="text-ui-subtle text-[9px] tracking-[0.2em] uppercase">Repository</p>
              {[
                ['LOC', shortLines(active.totals.linesOfCode)],
                ['Files', active.totals.filesScanned.toLocaleString('en-US')],
                ['Modules', active.modules.length],
                ['Tempo', `${activeScore.bpm}`],
              ].map(([label, value]) => (
                <div key={label} className="mt-3 flex items-baseline justify-between gap-4">
                  <span className="text-ui-subtle text-[9px] tracking-[0.12em] uppercase">
                    {label}
                  </span>
                  <span className="text-ui-secondary text-[11px] tabular-nums">{value}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="text-ui-subtle pointer-events-none absolute right-5 bottom-28 hidden text-right text-[9px] leading-relaxed tracking-[0.14em] uppercase sm:block">
            <p>Drag · orbit</p>
            <p>Wheel · zoom</p>
            <p>Arrows · orbit</p>
          </div>

          <div className="pointer-events-none absolute inset-x-3 bottom-3 sm:inset-x-5 sm:bottom-5">
            <div className="pointer-events-auto mx-auto flex max-w-[980px] items-center gap-3 rounded-[20px] border border-white/10 bg-[var(--surface-hud)] p-3 shadow-2xl backdrop-blur-2xl sm:gap-5 sm:px-5 sm:py-4">
              <button
                type="button"
                onClick={() => void play(active)}
                onPointerEnter={() => void audioModule()}
                onFocus={() => void audioModule()}
                disabled={starting === active.repo.commitSha}
                className="grid size-11 shrink-0 place-items-center rounded-full text-[var(--surface-stage)] transition hover:scale-105 disabled:opacity-50"
                style={{ background: activeAccent, boxShadow: `0 0 28px ${activeAccent}45` }}
                aria-label={
                  activeIsPlaying ? `Stop ${active.repo.name}` : `Play ${active.repo.name}`
                }
              >
                {activeIsPlaying ? (
                  <span className="block size-3 rounded-[2px] bg-[var(--surface-stage)]" />
                ) : (
                  <span className="ml-0.5 block h-0 w-0 border-y-[7px] border-l-[11px] border-y-transparent border-l-[var(--surface-stage)]" />
                )}
              </button>

              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-ui-strong truncate text-[10px]">
                    {active.repo.owner}/{active.repo.name}
                  </p>
                  <span className="text-ui-subtle text-[9px] tracking-[0.12em] uppercase">
                    {activeIsPlaying ? 'Audio reactive' : 'Press play'}
                  </span>
                </div>
                <div className="mt-3 h-px overflow-hidden bg-white/10">
                  <div
                    className="spectrum-progress h-full transition-transform duration-100"
                    style={{ background: activeAccent }}
                  />
                </div>
              </div>

              <div className="hidden w-[190px] grid-cols-3 gap-3 sm:grid">
                {SPECTRUM_KEYS.map((band) => (
                  <div key={band}>
                    <div className="flex h-6 items-end gap-px" aria-hidden>
                      {[0.03, 0.08, 0.16, 0.28, 0.42].map((gate) => (
                        <span
                          key={gate}
                          data-spectrum-bar={band}
                          data-gate={gate}
                          className="w-full rounded-[1px] transition-opacity duration-100"
                          style={{
                            height: `${30 + gate * 70}%`,
                            background: activeAccent,
                            opacity: 0.13,
                          }}
                        />
                      ))}
                    </div>
                    <p className="text-ui-subtle mt-1 flex justify-between text-[8px] tracking-[0.1em] uppercase">
                      <span>{band}</span>
                      <span data-spectrum-value={band} className="tabular-nums">
                        0
                      </span>
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        <div className="repo-rail mt-4 overflow-x-auto pb-2">
          <ul className="flex min-w-max snap-x snap-mandatory gap-2 sm:min-w-0 sm:snap-none">
            {entries.map((entry) => {
              const sha = entry.repo.commitSha;
              const score = scores.get(sha);
              const palette = palettes.get(sha);
              if (!score || !palette) return null;
              return (
                <li key={sha} className="flex min-w-[190px] flex-1 snap-start">
                  <Tile
                    features={entry}
                    score={score}
                    palette={palette}
                    selected={active.repo.commitSha === sha}
                    playing={playingSha === sha}
                    onToggle={() => void play(entry)}
                  />
                </li>
              );
            })}
          </ul>
        </div>

        {playing && (
          <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-3 border-t border-white/8 px-2 pt-5">
            <button
              type="button"
              onClick={() => void save(playing, true)}
              disabled={saving !== null}
              className="text-ui-secondary min-h-11 rounded-full border border-white/12 bg-white/8 px-4 py-2 text-[9px] tracking-[0.14em] uppercase hover:bg-white/12 disabled:opacity-40"
            >
              {saving === 'clip' ? 'Rendering' : `Save 30s of ${playing.repo.name}`}
            </button>
            <button
              type="button"
              onClick={() => void save(playing, false)}
              disabled={saving !== null}
              className="text-ui-muted min-h-11 rounded-full px-3 text-[9px] tracking-[0.1em] uppercase hover:bg-white/8 hover:text-white disabled:opacity-40"
            >
              {saving === 'full' ? 'Rendering the whole piece' : 'or the whole piece'}
            </button>
            <span className="text-ui-subtle text-[9px]">
              From the peak, where every voice is playing
            </span>

            <div className="flex w-full flex-wrap items-center gap-2">
              {(['square', 'vertical'] as const).map((shape) => (
                <button
                  key={shape}
                  type="button"
                  onClick={() => void record(playing, shape)}
                  disabled={saving !== null}
                  className="text-ui-muted min-h-11 rounded-full border border-white/10 px-3 py-2 text-[9px] tracking-[0.12em] uppercase hover:border-white/25 hover:text-white disabled:opacity-40"
                >
                  {saving === shape
                    ? `Recording ${Math.round(recorded * 100)}%`
                    : `${shape} video`}
                </button>
              ))}
              <button
                type="button"
                onClick={() => void saveCard(playing)}
                disabled={saving !== null}
                className="text-ui-muted min-h-11 rounded-full border border-white/10 px-3 py-2 text-[9px] tracking-[0.12em] uppercase hover:border-white/25 hover:text-white disabled:opacity-40"
              >
                {saving === 'card' ? 'Drawing' : 'Card'}
              </button>
              <span className="text-ui-subtle text-[9px]">
                {saving === 'square' || saving === 'vertical'
                  ? 'Recording happens in real time — thirty seconds'
                  : 'Same thirty seconds, with the picture'}
              </span>
            </div>
          </div>
        )}

        {starting && (
          <p className="text-ui-muted mt-5 px-2 text-[9px] tracking-[0.16em] uppercase">
            Starting audio
          </p>
        )}

        {/* Held back until the visitor has heard something. A repository box is a question,
            and asking it before showing what the answer sounds like gets no answer. */}
        {heard && (
          <section
            ref={inputSection}
            className="mt-12 border-t border-white/8 px-2 pt-8 sm:mt-16"
          >
            <h2 className="text-ui-muted text-[10px] tracking-[0.18em] uppercase">
              Hear your own
            </h2>
            <form
              className="mt-3 flex max-w-[420px] gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void load(input);
              }}
            >
              <input
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder="your-username"
                maxLength={200}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                aria-label="GitHub username, or a repository"
                aria-describedby="repo-input-hint"
                className="min-h-11 min-w-0 flex-1 rounded-full border border-white/10 bg-white/5 px-4 py-2.5 text-[16px] text-white placeholder:text-[var(--text-subtle)] focus:border-white/25 sm:text-[12px]"
              />
              <button
                type="submit"
                disabled={loading !== null}
                aria-busy={loading !== null}
                className="min-h-11 rounded-full bg-white px-5 py-2 text-[10px] tracking-[0.12em] text-[var(--surface-stage)] uppercase disabled:opacity-40"
              >
                {loading === 'user' ? 'Looking up' : loading === 'repo' ? 'Reading' : 'Play'}
              </button>
            </form>
            {/* Said before the answer arrives, because a box that silently accepts two
                different things is a box nobody tries the second thing in. */}
            <p
              id="repo-input-hint"
              className="text-ui-subtle mt-3 max-w-[58ch] text-[10px] leading-relaxed"
            >
              A username plays that account&rsquo;s most-starred repository. An{' '}
              <span className="text-ui-secondary">owner/repo</span> plays exactly that one.
              Public, and in TypeScript, JavaScript, Python or Go.
            </p>

            {pick && (
              <div className="mt-5 flex items-center gap-3">
                {pick.avatar && (
                  <img
                    src={pick.avatar}
                    alt=""
                    className="size-9 shrink-0 rounded-full ring-1 ring-white/10"
                  />
                )}
                <p className="text-ui-muted max-w-[46ch] text-[10px] leading-relaxed">
                  {pickSummary(pick)}
                </p>
              </div>
            )}
          </section>
        )}

        {error && (
          <div
            id="codetta-error"
            role="alert"
            className="mt-5 flex max-w-[68ch] items-center gap-3 px-2 text-[11px] leading-relaxed text-[var(--text-error)]"
          >
            <p className="min-w-0 flex-1">{error}</p>
            <button
              type="button"
              onClick={() => setError(null)}
              className="text-ui-secondary min-h-11 shrink-0 rounded-full px-3 text-[9px] tracking-[0.12em] uppercase hover:bg-white/8"
            >
              Dismiss
            </button>
          </div>
        )}
      </div>
    </main>
  );
}
