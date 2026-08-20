import type { RepoFeatures } from '@codetta/schema';
import { clipWindow } from '../music/clip';
import { barToTick, scoreDurationSeconds, type Score, type VoiceId } from '../music/score';
import { onsetsBetween, ticksAtSeconds } from './clock';
import { drawField } from './draw';
import { fieldFor } from './layout';
import { paletteFor, type Palette } from './palette';

/**
 * Record the shareable clip as a video.
 *
 * ## Why this plays a rendered buffer instead of the piece
 *
 * MediaRecorder captures in real time; there is no offline equivalent. That leaves two
 * obvious approaches and both are wrong. Playing the whole piece and recording only the peak
 * costs the visitor a minute of waiting for thirty seconds of video. Starting the transport
 * at the peak is fast and produces a different clip from the WAV — the reverb tails and the
 * pad still ringing from the bars before it would be missing, which is precisely the thing
 * the audio clip is careful to keep.
 *
 * So the audio is rendered offline first, exactly as the WAV is, and the recording plays that
 * buffer. Thirty seconds of real time, and the sound in the video is the sound in the file,
 * not a second performance that resembles it.
 *
 * ## Why the canvas follows the audio
 *
 * The same rule as the page: the frame decides when to paint, never what time it is. Here the
 * clock is the buffer source's own progress through the context, offset by where the clip
 * starts, so a dropped frame moves the picture and never the sound.
 */

export type Shape = 'square' | 'vertical';

/** 1080 on the short edge: what every platform wants, and small enough to encode live. */
const SIZES: Record<Shape, { width: number; height: number }> = {
  square: { width: 1080, height: 1080 },
  vertical: { width: 1080, height: 1920 },
};

/**
 * Container and codecs, in the order they are worth having.
 *
 * MP4 first because it is the one a phone will open without thinking about it, and Safari
 * produces it. WebM is what Chrome and Firefox have always produced. Nothing here assumes:
 * `isTypeSupported` decides, and a browser offering none of them is told so rather than
 * handed an empty file.
 */
const CANDIDATES = [
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

export function supportedVideoType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  return CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type));
}

export interface RecordOptions {
  score: Score;
  features: RepoFeatures;
  /** The clip's audio, already rendered offline — the same samples the WAV is written from. */
  audio: { sampleRate: number; channels: Float32Array[] };
  shape: Shape;
  palette?: Palette | undefined;
  /** Progress through the recording, 0–1, for a caller that wants to show it. */
  onProgress?: ((fraction: number) => void) | undefined;
}

export async function recordClip(options: RecordOptions): Promise<Blob> {
  const { score, features, audio, shape, palette: given, onProgress } = options;

  const type = supportedVideoType();
  if (!type) {
    throw new Error('This browser cannot record video. The audio download still works.');
  }

  const { width, height } = SIZES[shape];
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser would not give us a canvas to draw on.');

  const scene = {
    columns: fieldFor(features),
    palette: given ?? paletteFor(score.seed),
    fileCount: features.timeline.length,
    durationSeconds: scoreDurationSeconds(score),
    totalTicks: barToTick(score.bars),
  };

  // Its own context, so recording never disturbs whatever the page is playing, and its own
  // graph, so nothing here is competing for the transport. Created at the rendered sample
  // rate rather than the device default: a mismatch would play the clip at the wrong speed
  // and pitch, which is a failure that sounds like a creative decision.
  const audioContext = new AudioContext({ sampleRate: audio.sampleRate });
  const buffer = audioContext.createBuffer(
    audio.channels.length,
    audio.channels[0]?.length ?? 0,
    audio.sampleRate,
  );
  for (const [at, channel] of audio.channels.entries()) {
    // Copied into a buffer this context owns rather than handed one it did not make. A
    // rendered Float32Array is backed by whatever the offline context allocated, and the
    // typings are right to keep the two apart.
    buffer.getChannelData(at).set(channel);
  }

  const source = audioContext.createBufferSource();
  source.buffer = buffer;
  const destination = audioContext.createMediaStreamDestination();
  source.connect(destination);

  const stream = canvas.captureStream(60);
  for (const track of destination.stream.getAudioTracks()) stream.addTrack(track);

  const recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 6_000_000 });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };

  const window_ = clipWindow(score);
  const flares = new Map<VoiceId, number>();
  let frameHandle = 0;
  let previousTick = ticksAtSeconds(window_.startSeconds, score.bpm, scene.totalTicks);
  let previousTime = performance.now();

  const finished = new Promise<Blob>((resolve, reject) => {
    recorder.onerror = () => reject(new Error('The recording failed part way through.'));
    recorder.onstop = () => {
      cancelAnimationFrame(frameHandle);
      audioContext.close().catch(() => {});
      resolve(new Blob(chunks, { type }));
    };
  });

  const startedAt = audioContext.currentTime;
  const paint = (now: number) => {
    frameHandle = requestAnimationFrame(paint);

    // The audio's own clock, not the frame's. Offset by where the clip begins, so the field
    // shows the peak rather than restarting the piece.
    const elapsed = Math.max(0, audioContext.currentTime - startedAt);
    const tick = ticksAtSeconds(window_.startSeconds + elapsed, score.bpm, scene.totalTicks);
    const onsets = onsetsBetween(score.events, previousTick, tick, scene.totalTicks);
    const delta = Math.max(0, (now - previousTime) / 1000);

    previousTick = tick;
    previousTime = now;

    drawField(context, width, height, scene, { tick, onsets, delta }, flares);
    onProgress?.(Math.min(1, elapsed / window_.durationSeconds));
  };

  // One frame before anything starts, so the first captured frame is the repository rather
  // than a blank rectangle.
  drawField(
    context,
    width,
    height,
    scene,
    { tick: previousTick, onsets: [], delta: 0 },
    flares,
  );

  recorder.start();
  source.start();
  frameHandle = requestAnimationFrame(paint);

  // Driven by the source ending rather than by a timer: the buffer knows exactly how long it
  // is, and a timer would have to agree with it.
  source.onended = () => recorder.state !== 'inactive' && recorder.stop();

  return finished;
}

export function videoFilename(
  score: Score,
  owner: string,
  name: string,
  shape: Shape,
  type: string,
): string {
  const extension = type.startsWith('video/mp4') ? 'mp4' : 'webm';
  return `codetta-${owner}-${name}-${score.seed}-${shape}.${extension}`;
}
