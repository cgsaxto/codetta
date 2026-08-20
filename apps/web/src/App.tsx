import { useEffect, useMemo, useRef, useState } from 'react';
import type { RepoFeatures } from '@codetta/schema';
import { renderClip, renderWav, startPlayback, wavFilename, type Player } from './audio/player';
import { ApiError, fetchFeatures, parseTarget, type RepoRef } from './features/api';
import { fetchUserPick, pickSummary, type UserPick } from './features/user';
import { GALLERY } from './features/gallery';
import { pathForRepo, repoFromPath } from './features/route';
import { generateScore } from './music/generate';
import type { Score } from './music/score';
import { Field } from './visuals/Field';
import { cardFilename, loadAvatar, renderCard, shortLines } from './visuals/card';
import { palettesFor, type Palette } from './visuals/palette';
import { recordClip, supportedVideoType, videoFilename, type Shape } from './visuals/record';

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
  buttonRef?: (node: HTMLButtonElement | null) => void;
  features: RepoFeatures;
  score: Score;
  palette: Palette;
  playing: boolean;
  player: Player | null;
  onToggle: () => void;
}

function Tile({ buttonRef, features, score, palette, playing, player, onToggle }: TileProps) {
  const accent = palette.modules[0] ?? '#888';
  const { repo } = features;

  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onToggle}
      aria-pressed={playing}
      className="group block w-full rounded-[4px] text-left outline-offset-4 focus-visible:outline-2 focus-visible:outline-[#0e1013]"
    >
      <div
        className="overflow-hidden rounded-[3px] ring-1 transition-[box-shadow,transform] duration-200 group-focus-visible:ring-2"
        style={{
          boxShadow: playing ? `0 0 0 1.5px ${accent}` : undefined,
          // Hairline by default; the repository's own colour on hover and while playing.
          ['--tw-ring-color' as string]: playing ? accent : '#dfe2e6',
        }}
      >
        <Field
          player={player}
          score={score}
          features={features}
          palette={palette}
          height={172}
        />
      </div>

      <div className="mt-2.5 flex items-baseline gap-1.5">
        <span
          aria-hidden
          className="size-[7px] shrink-0 rounded-[1px] transition-opacity"
          style={{ background: accent, opacity: playing ? 1 : 0.28 }}
        />
        <span className="truncate text-[15px] leading-none font-medium text-[#0e1013]">
          {repo.name}
        </span>
        <span className="truncate text-[11px] leading-none text-[#9aa1ab]">{repo.owner}</span>
      </div>

      <div className="mt-1.5 text-[10px] tracking-[0.16em] text-[#767c86] uppercase">
        {repo.primaryLanguage} · {shortLines(features.totals.linesOfCode)} · {score.bpm} bpm
      </div>
    </button>
  );
}

export default function App() {
  const [player, setPlayer] = useState<Player | null>(null);
  const [playingSha, setPlayingSha] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const [heard, setHeard] = useState(false);

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
  const tiles = useRef(new Map<string, HTMLButtonElement>());

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

  /**
   * Put the tile a link named in front of the visitor, and under their cursor.
   *
   * Focus rather than only scroll, so the keyboard can play it immediately — and because a
   * link that lands on a grid of eight with no indication of which one it meant has not
   * really arrived anywhere.
   */
  useEffect(() => {
    if (!focusSha) return;
    const tile = tiles.current.get(focusSha);
    if (!tile) return;

    const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    tile.scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'center' });
    tile.focus({ preventScroll: true });
  }, [focusSha, entries]);

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

  return (
    <main className="min-h-dvh bg-[#f2f3f5] px-5 py-10 font-mono text-[#0e1013] sm:px-8 sm:py-14">
      <div className="mx-auto max-w-[1180px]">
        <header className="mb-9 sm:mb-12">
          <h1 className="text-[12px] tracking-[0.32em] uppercase">Codetta</h1>
          <p className="mt-3 max-w-[46ch] text-[13px] leading-relaxed text-[#575d66]">
            Eight repositories, played as they are written. Ordered by size, which is what sets
            the tempo.
          </p>
        </header>

        <ul className="grid grid-cols-1 gap-x-5 gap-y-8 sm:grid-cols-2 lg:grid-cols-4">
          {entries.map((entry) => {
            const sha = entry.repo.commitSha;
            const score = scores.get(sha);
            const palette = palettes.get(sha);
            if (!score || !palette) return null;
            return (
              <li key={sha}>
                <Tile
                  buttonRef={(node) => {
                    if (node) tiles.current.set(sha, node);
                    else tiles.current.delete(sha);
                  }}
                  features={entry}
                  score={score}
                  palette={palette}
                  playing={playingSha === sha}
                  player={playingSha === sha ? player : null}
                  onToggle={() => void play(entry)}
                />
              </li>
            );
          })}
        </ul>

        {playing && (
          <div className="mt-8 flex flex-wrap items-center gap-x-4 gap-y-2">
            <button
              type="button"
              onClick={() => void save(playing, true)}
              disabled={saving !== null}
              className="rounded-[3px] bg-[#0e1013] px-3 py-1.5 text-[11px] tracking-[0.12em] text-[#f2f3f5] uppercase disabled:opacity-40"
            >
              {saving === 'clip' ? 'Rendering' : `Save 30s of ${playing.repo.name}`}
            </button>
            <button
              type="button"
              onClick={() => void save(playing, false)}
              disabled={saving !== null}
              className="text-[11px] text-[#575d66] underline underline-offset-4 hover:text-[#0e1013] disabled:opacity-40"
            >
              {saving === 'full' ? 'Rendering the whole piece' : 'or the whole piece'}
            </button>
            <span className="text-[11px] text-[#767c86]">
              From the peak, where every voice is playing
            </span>

            <div className="flex w-full items-center gap-3">
              {(['square', 'vertical'] as const).map((shape) => (
                <button
                  key={shape}
                  type="button"
                  onClick={() => void record(playing, shape)}
                  disabled={saving !== null}
                  className="rounded-[3px] border border-[#dfe2e6] px-3 py-1.5 text-[11px] tracking-[0.12em] text-[#575d66] uppercase hover:border-[#0e1013] hover:text-[#0e1013] disabled:opacity-40"
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
                className="rounded-[3px] border border-[#dfe2e6] px-3 py-1.5 text-[11px] tracking-[0.12em] text-[#575d66] uppercase hover:border-[#0e1013] hover:text-[#0e1013] disabled:opacity-40"
              >
                {saving === 'card' ? 'Drawing' : 'Card'}
              </button>
              <span className="text-[11px] text-[#767c86]">
                {saving === 'square' || saving === 'vertical'
                  ? 'Recording happens in real time — thirty seconds'
                  : 'Same thirty seconds, with the picture'}
              </span>
            </div>
          </div>
        )}

        {starting && (
          <p className="mt-8 text-[11px] tracking-[0.16em] text-[#767c86] uppercase">
            Starting audio
          </p>
        )}

        {/* Held back until the visitor has heard something. A repository box is a question,
            and asking it before showing what the answer sounds like gets no answer. */}
        {heard && (
          <section ref={inputSection} className="mt-16 border-t border-[#dfe2e6] pt-8 sm:mt-20">
            <h2 className="text-[10px] tracking-[0.18em] text-[#767c86] uppercase">
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
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                aria-label="GitHub username, or a repository"
                className="min-w-0 flex-1 rounded-[3px] border border-[#dfe2e6] bg-white px-3 py-2 text-[13px] outline-none placeholder:text-[#9aa1ab] focus:border-[#0e1013]"
              />
              <button
                type="submit"
                disabled={loading !== null}
                className="rounded-[3px] bg-[#0e1013] px-4 py-2 text-[12px] tracking-[0.1em] text-[#f2f3f5] uppercase disabled:opacity-40"
              >
                {loading === 'user' ? 'Looking up' : loading === 'repo' ? 'Reading' : 'Play'}
              </button>
            </form>
            {/* Said before the answer arrives, because a box that silently accepts two
                different things is a box nobody tries the second thing in. */}
            <p className="mt-3 max-w-[46ch] text-[12px] leading-relaxed text-[#767c86]">
              A username plays that account&rsquo;s most-starred repository. An{' '}
              <span className="text-[#575d66]">owner/repo</span> plays exactly that one. Public,
              and in TypeScript, JavaScript, Python or Go.
            </p>

            {pick && (
              <div className="mt-5 flex items-center gap-3">
                {pick.avatar && (
                  <img
                    src={pick.avatar}
                    alt=""
                    className="size-9 shrink-0 rounded-full ring-1 ring-[#dfe2e6]"
                  />
                )}
                <p className="max-w-[46ch] text-[12px] leading-relaxed text-[#575d66]">
                  {pickSummary(pick)}
                </p>
              </div>
            )}
          </section>
        )}

        {error && (
          <p className="mt-5 max-w-[46ch] text-[12px] leading-relaxed text-[#a1201a]">
            {error}
          </p>
        )}
      </div>
    </main>
  );
}
