import { useState } from 'react';
import { start, type EngineStatus } from './audio/engine';
import { reactFeatures } from './features/fixture';

export default function App() {
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleStart() {
    try {
      setStatus(await start());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  const { repo, totals } = reactFeatures;

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 p-8 font-mono text-sm">
      <h1 className="text-2xl font-semibold tracking-tight">Codetta</h1>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-neutral-600">
        <dt>fixture</dt>
        <dd>
          {repo.owner}/{repo.name}
        </dd>
        <dt>seed</dt>
        <dd>{reactFeatures.seed}</dd>
        <dt>lines</dt>
        <dd>{totals.linesOfCode.toLocaleString('en-US')}</dd>
      </dl>

      <button
        type="button"
        onClick={() => void handleStart()}
        className="rounded border border-neutral-400 px-4 py-2 hover:bg-neutral-100"
      >
        Start audio
      </button>

      {status && (
        <p className="text-neutral-600">
          context {status.state} @ {status.sampleRate} Hz
        </p>
      )}
      {error && <p className="text-red-600">{error}</p>}

      <p className="text-xs text-neutral-400">
        Phase 0 scaffold. No music yet — this only proves the audio chain and the fixture loader
        work.
      </p>
    </main>
  );
}
