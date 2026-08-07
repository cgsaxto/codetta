import { useEffect, useMemo, useState } from 'react';
import { startPlayback, type Player } from './audio/player';
import { reactFeatures } from './features/fixture';
import { generateScore } from './music/generate';
import { scoreDurationSeconds } from './music/score';

export default function App() {
  const score = useMemo(() => generateScore(reactFeatures), []);
  const [player, setPlayer] = useState<Player | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => () => player?.stop(), [player]);

  async function toggle() {
    if (player) {
      player.stop();
      setPlayer(null);
      return;
    }
    setBusy(true);
    try {
      setPlayer(await startPlayback(score));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const { repo } = reactFeatures;
  const rows: Array<[string, string]> = [
    ['repo', `${repo.owner}/${repo.name}`],
    ['seed', score.seed],
    ['key', `${score.root} ${score.mode}`],
    ['tempo', `${score.bpm} BPM`],
    ['loop', score.progressionId],
    ['length', `${score.bars} bars · ${scoreDurationSeconds(score).toFixed(1)} s`],
    ['notes', `${score.events.length}`],
  ];

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-8 p-8 font-mono text-sm">
      <h1 className="text-2xl font-semibold tracking-tight">Codetta</h1>

      <dl className="grid grid-cols-[4.5rem_1fr] gap-y-1 text-neutral-500">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt>{label}</dt>
            <dd className="text-neutral-900">{value}</dd>
          </div>
        ))}
      </dl>

      <button
        type="button"
        onClick={() => void toggle()}
        disabled={busy}
        className="rounded border border-neutral-900 px-4 py-3 font-medium hover:bg-neutral-900 hover:text-white disabled:opacity-40"
      >
        {busy ? 'loading…' : player ? 'stop' : 'play'}
      </button>

      {error && <p className="text-red-600">{error}</p>}

      <p className="text-xs leading-relaxed text-neutral-400">
        Pad and bass only, looping. The roadmap gate: is this pleasant on repeat? Everything
        else is built on top of it, so if this is not enjoyable nothing above it will be.
        Headphones — the bass sits in C1–C2.
      </p>
    </main>
  );
}
