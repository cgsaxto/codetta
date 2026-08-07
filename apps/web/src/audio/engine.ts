import * as Tone from 'tone';

export interface EngineStatus {
  state: AudioContextState;
  sampleRate: number;
}

let limiter: Tone.Limiter | undefined;

/**
 * The one node anything audible is allowed to connect to. Voices connect here, never to
 * the destination — that is what guarantees the master chain always ends in a limiter.
 */
export function masterBus(): Tone.Limiter {
  limiter ??= new Tone.Limiter(-1).toDestination();
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
