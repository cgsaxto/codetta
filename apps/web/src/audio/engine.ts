import * as Tone from 'tone';

export interface EngineStatus {
  state: AudioContextState;
  sampleRate: number;
}

/**
 * One limiter per context, rather than one limiter.
 *
 * A single memoised node was fine while there was only ever the live context. Rendering a
 * file uses an OfflineAudioContext, and a node belongs to the context that created it —
 * handing the offline graph the live limiter connects the render to the speakers and leaves
 * the file silent. Keyed by context so both paths get their own, and weakly so a finished
 * offline render is not held alive by this map.
 */
const limiters = new WeakMap<object, Tone.Limiter>();

/**
 * The one node anything audible is allowed to connect to. Voices connect here, never to
 * the destination — that is what guarantees the master chain always ends in a limiter.
 */
export function masterBus(): Tone.Limiter {
  const context = Tone.getContext();
  let limiter = limiters.get(context);
  if (!limiter) {
    limiter = new Tone.Limiter(-1).toDestination();
    limiters.set(context, limiter);
  }
  return limiter;
}

/**
 * Resume the AudioContext. Browsers only allow this from a user gesture, so this must be
 * called from a click handler and never on mount.
 */
export async function start(): Promise<EngineStatus> {
  await Tone.start();
  masterBus();
  const context = Tone.getContext();
  return { state: context.state, sampleRate: context.sampleRate };
}
