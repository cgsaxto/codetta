import { useEffect, useMemo, useState } from 'react';
import { startPlayback, type Player } from './audio/player';
import { FIXTURES, type FixtureName } from './features/fixture';
import { generateScore } from './music/generate';
import { scoreDurationSeconds, type Score } from './music/score';

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

export default function App() {
  const [name, setName] = useState<FixtureName>('react');
  const features = FIXTURES[name];
  const score = useMemo(() => generateScore(features), [features]);
  const [player, setPlayer] = useState<Player | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => () => player?.stop(), [player]);

  function stop() {
    player?.stop();
    setPlayer(null);
  }

  async function toggle() {
    if (player) {
      stop();
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

  const { repo } = features;
  const rows: Array<[string, string]> = [
    ['repo', `${repo.owner}/${repo.name}`],
    ['seed', score.seed],
    ['key', `${score.root} ${score.mode}`],
    ['tempo', `${score.bpm} BPM`],
    ['loop', score.progressionId],
    ['length', `${score.bars} bars · ${scoreDurationSeconds(score).toFixed(1)} s`],
    ['notes', `${score.events.length}`],
    ['lead', leadSummary(score)],
  ];

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-8 p-8 font-mono text-sm">
      <h1 className="text-2xl font-semibold tracking-tight">Codetta</h1>

      {/* A/B between the two ends of the calibration. Not a product feature — Phase 3 owns
          what choosing a repo looks like, and it is a gallery, not a pair of buttons. This
          is here because "is react too sparse" is only answerable against something else. */}
      <div className="flex gap-2">
        {(Object.keys(FIXTURES) as FixtureName[]).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => {
              stop();
              setName(option);
            }}
            className={`rounded border px-3 py-1.5 ${
              option === name
                ? 'border-neutral-900 bg-neutral-900 text-white'
                : 'border-neutral-300 text-neutral-500 hover:border-neutral-900'
            }`}
          >
            {FIXTURES[option].repo.name}
          </button>
        ))}
      </div>

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
        Both are real API output. The lead is the largest module, and the question these two are
        here to answer is whether it carries anything: react&rsquo;s largest module is flat DOM
        plumbing, requests&rsquo; is the library itself. The peak starts around bar&nbsp;12 and
        is where the shareable clip is cut from. Headphones — the bass sits in C1–C2.
      </p>
    </main>
  );
}
