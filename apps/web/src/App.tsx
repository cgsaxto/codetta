import { useEffect, useMemo, useRef, useState } from 'react';
import type { RepoFeatures } from '@codetta/schema';
import { startPlayback, type Player } from './audio/player';
import { ApiError, fetchFeatures, parseRepoRef } from './features/api';
import { FIXTURES, type FixtureName } from './features/fixture';
import { generateScore } from './music/generate';
import { scoreDurationSeconds, type Score } from './music/score';
import { Field } from './visuals/Field';

/**
 * What Layer 3 actually did to the most prominent voice, in one line. Note count and pitch
 * span are the two numbers that separated the calm end of the calibration set from the busy
 * end, so they are the two worth having on screen while listening.
 */
function leadSummary(score: Score): string {
  const midi = score.events.filter((event) => event.voice === 'lead').map((e) => e.midi);
  if (midi.length === 0) return 'silent';
  return `${midi.length} notes · ${Math.max(...midi) - Math.min(...midi)} semitone span`;
}

/** The two committed fixtures, playable with no service running. */
const EXAMPLES = Object.keys(FIXTURES) as FixtureName[];

export default function App() {
  const [features, setFeatures] = useState<RepoFeatures>(FIXTURES.react);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [player, setPlayer] = useState<Player | null>(null);
  const [starting, setStarting] = useState(false);
  const [fps, setFps] = useState(0);

  // So a slow repository can be abandoned when another is asked for, rather than arriving
  // later and replacing whatever is playing by then.
  const pending = useRef<AbortController | null>(null);

  const score = useMemo(() => generateScore(features), [features]);

  useEffect(() => () => player?.stop(), [player]);
  useEffect(() => () => pending.current?.abort(), []);

  function stop() {
    player?.stop();
    setPlayer(null);
  }

  function show(next: RepoFeatures) {
    stop();
    setFeatures(next);
    setError(null);
  }

  async function load(text: string) {
    const repo = parseRepoRef(text);
    if (!repo) {
      setError('That does not look like a repository. Try `facebook/react`.');
      return;
    }

    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;

    stop();
    setLoading(true);
    setError(null);
    try {
      show(await fetchFeatures(repo, controller.signal));
    } catch (cause) {
      if (controller.signal.aborted) return;
      setError(cause instanceof ApiError ? cause.message : String(cause));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  async function toggle() {
    if (player) {
      stop();
      return;
    }
    setStarting(true);
    try {
      setPlayer(await startPlayback(score));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setStarting(false);
    }
  }

  const { repo } = features;
  const rows: Array<[string, string]> = [
    ['repo', `${repo.owner}/${repo.name}`],
    ['seed', score.seed],
    ['key', `${score.root} ${score.mode}`],
    ['tempo', `${score.bpm} BPM`],
    ['loop', score.progressionId],
    ['kit', score.kit],
    ['length', `${score.bars} bars · ${scoreDurationSeconds(score).toFixed(1)} s`],
    ['notes', `${score.events.length}`],
    ['lead', leadSummary(score)],
    ...(player && fps > 0 ? ([['frames', `${fps} fps`]] as Array<[string, string]>) : []),
  ];

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 p-8 font-mono text-sm">
      <h1 className="text-2xl font-semibold tracking-tight">Codetta</h1>

      <form
        className="flex gap-2"
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
          className="min-w-0 flex-1 rounded border border-neutral-300 px-3 py-1.5 outline-none focus:border-neutral-900"
        />
        <button
          type="submit"
          disabled={loading}
          className="rounded border border-neutral-900 px-3 py-1.5 font-medium hover:bg-neutral-900 hover:text-white disabled:opacity-40"
        >
          {loading ? 'reading…' : 'load'}
        </button>
      </form>

      {/* The committed fixtures. They need no service, and they sit at opposite ends of the
          calibration, which is what makes them worth keeping as the first thing heard. */}
      <div className="flex gap-2 text-xs">
        {EXAMPLES.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => show(FIXTURES[option])}
            className={`rounded border px-2 py-1 ${
              FIXTURES[option].repo.commitSha === repo.commitSha
                ? 'border-neutral-900 bg-neutral-900 text-white'
                : 'border-neutral-300 text-neutral-500 hover:border-neutral-900'
            }`}
          >
            {FIXTURES[option].repo.name}
          </button>
        ))}
      </div>

      <Field player={player} score={score} features={features} onFrameRate={setFps} />

      <dl className="grid grid-cols-[4.5rem_1fr] gap-y-1 text-neutral-500">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt>{label}</dt>
            <dd className="truncate text-neutral-900">{value}</dd>
          </div>
        ))}
      </dl>

      <button
        type="button"
        onClick={() => void toggle()}
        disabled={starting}
        className="rounded border border-neutral-900 px-4 py-3 font-medium hover:bg-neutral-900 hover:text-white disabled:opacity-40"
      >
        {starting ? 'loading…' : player ? 'stop' : 'play'}
      </button>

      {error && <p className="text-red-600">{error}</p>}

      <p className="text-xs leading-relaxed text-neutral-400">
        Paste any public repository in TypeScript, JavaScript, Python or Go. Large ones take a
        few seconds the first time and are instant afterwards. The peak starts around bar 12,
        which is where the shareable clip gets cut from. Headphones — the bass sits in C1–C2.
      </p>
    </main>
  );
}
