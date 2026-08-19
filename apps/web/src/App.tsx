import { useEffect, useMemo, useRef, useState } from 'react';
import type { RepoFeatures } from '@codetta/schema';
import { renderWav, startPlayback, wavFilename, type Player } from './audio/player';
import { ApiError, fetchFeatures, parseRepoRef } from './features/api';
import { GALLERY } from './features/gallery';
import { generateScore } from './music/generate';
import type { Score } from './music/score';
import { Field } from './visuals/Field';
import { palettesFor, type Palette } from './visuals/palette';

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

function shortLines(count: number): string {
  return count >= 1000 ? `${Math.round(count / 1000)}k lines` : `${count} lines`;
}

interface TileProps {
  features: RepoFeatures;
  score: Score;
  palette: Palette;
  playing: boolean;
  player: Player | null;
  onToggle: () => void;
}

function Tile({ features, score, palette, playing, player, onToggle }: TileProps) {
  const accent = palette.modules[0] ?? '#888';
  const { repo } = features;

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={playing}
      className="group block w-full text-left focus:outline-none"
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

  const [saving, setSaving] = useState(false);
  const [custom, setCustom] = useState<RepoFeatures | null>(null);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pending = useRef<AbortController | null>(null);
  const heardTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputSection = useRef<HTMLElement | null>(null);

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
  async function save(entry: RepoFeatures) {
    const sha = entry.repo.commitSha;
    const score = scores.get(sha) ?? generateScore(entry);

    setSaving(true);
    setError(null);
    try {
      const blob = await renderWav(score);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = wavFilename(score, entry.repo.owner, entry.repo.name);
      link.click();
      // Released on the next tick rather than immediately: revoking before the browser has
      // taken the URL cancels the download in some of them.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  async function load(text: string) {
    const repo = parseRepoRef(text);
    if (!repo) {
      setError('That does not look like a repository. Try facebook/react.');
      return;
    }

    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;

    stop();
    setLoading(true);
    setError(null);
    try {
      const loaded = await fetchFeatures(repo, controller.signal);
      setCustom(loaded);
      void play(loaded);
    } catch (cause) {
      if (controller.signal.aborted) return;
      setError(cause instanceof ApiError ? cause.message : String(cause));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
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
          <div className="mt-8 flex items-center gap-3">
            <button
              type="button"
              onClick={() => void save(playing)}
              disabled={saving}
              className="rounded-[3px] border border-[#0e1013] px-3 py-1.5 text-[11px] tracking-[0.12em] uppercase hover:bg-[#0e1013] hover:text-[#f2f3f5] disabled:opacity-40"
            >
              {saving ? 'Rendering' : `Save ${playing.repo.name}.wav`}
            </button>
            <span className="text-[11px] text-[#767c86]">
              {saving ? 'Faster than real time' : 'The whole piece, exactly as you hear it'}
            </span>
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
              Play your own
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
                placeholder="owner/repo"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                aria-label="Repository to play"
                className="min-w-0 flex-1 rounded-[3px] border border-[#dfe2e6] bg-white px-3 py-2 text-[13px] outline-none placeholder:text-[#9aa1ab] focus:border-[#0e1013]"
              />
              <button
                type="submit"
                disabled={loading}
                className="rounded-[3px] bg-[#0e1013] px-4 py-2 text-[12px] tracking-[0.1em] text-[#f2f3f5] uppercase disabled:opacity-40"
              >
                {loading ? 'Reading' : 'Play'}
              </button>
            </form>
            <p className="mt-3 max-w-[46ch] text-[12px] leading-relaxed text-[#767c86]">
              Public repositories in TypeScript, JavaScript, Python or Go. Large ones take a few
              seconds the first time.
            </p>
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
