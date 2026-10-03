import type { RepoFeatures } from '@codetta/schema';
import { clipWindow } from '../music/clip';
import { barToTick, type Score } from '../music/score';
import type { CardSubject } from './card';
import { ticksAtSeconds } from './clock';
import type { Palette } from './palette';
import type { ViewMode } from './spatial';

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
 *
 * ## The offset that is left, and why it stays
 *
 * Measured against the WAV, the audio in a recorded mp4 begins about 49 ms late. That is not
 * drift and not a mistake here: AAC reserves priming samples at the head of a stream, 1024 to
 * 2112 of them, and 49 ms at 44.1 kHz is squarely inside that range. The encoder is doing what
 * the format requires.
 *
 * It is left alone deliberately. The sound arriving fifty milliseconds after the picture is
 * the direction people tolerate — it is what distance does to every sound anyone has ever
 * watched being made — and it is well inside what broadcast practice treats as undetectable.
 * And compensating would mean delaying the video by a constant, which is right for AAC and
 * wrong for Opus in the WebM path, so the fix would be correct in one container and would
 * introduce the very error it removes in the other.
 *
 * ## What is recorded
 *
 * The page's own 3D scene, mounted offscreen at the size of the video, with the card's text
 * over it — see record-scene.tsx. This file used to draw the 2D field itself, and went on
 * doing so after the page stopped showing it: the button on a 3D scene saved a video of a
 * picture the site no longer had, with nothing failing anywhere. The scene is imported only
 * when a recording starts, so three.js stays out of the bundle a visitor downloads.
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
  /** The colours the repository wears on the page, so the video matches what was on screen. */
  palette: Palette;
  /** Which of the two views to record. The one the visitor is looking at. */
  mode: ViewMode;
  avatar?: CardSubject['avatar'];
  /** Progress through the recording, 0–1, for a caller that wants to show it. */
  onProgress?: ((fraction: number) => void) | undefined;
}

/**
 * Where the piece is, `elapsed` seconds into the clip.
 *
 * Offset by where the clip begins, so the scene shows the peak rather than restarting the
 * piece. Pure, and separate from the recorder, because it is the one line that decides
 * whether the picture and the sound in a clip are the same thirty seconds.
 */
export function clipTick(score: Score, elapsedSeconds: number): number {
  const start = clipWindow(score).startSeconds;
  return ticksAtSeconds(start + Math.max(0, elapsedSeconds), score.bpm, barToTick(score.bars));
}

/** How long the scene may take to produce its first frames before the recording gives up. */
const SCENE_TIMEOUT_MS = 15_000;

export async function recordClip(options: RecordOptions): Promise<Blob> {
  const { score, features, audio, shape, palette, mode, avatar, onProgress } = options;

  const type = supportedVideoType();
  if (!type) {
    throw new Error('This browser cannot record video. The audio download still works.');
  }

  const { width, height } = SIZES[shape];
  const duration = clipWindow(score).durationSeconds;

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

  // Null until the source starts. Before that the scene holds the clip's first frame, so
  // the recording opens on the repository rather than on whatever tick zero looks like.
  let startedAt: number | null = null;
  const elapsed = () =>
    startedAt === null ? 0 : Math.max(0, audioContext.currentTime - startedAt);

  const { mountClipSurface } = await import('./record-scene');
  const surface = mountClipSurface({
    subject: { features, score, palette, avatar },
    mode,
    width,
    height,
    // The audio's own clock, not the frame's: a dropped frame moves the picture and never
    // the sound.
    position: () => clipTick(score, elapsed()),
    onFrame: () => {
      if (startedAt !== null) onProgress?.(Math.min(1, elapsed() / duration));
    },
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      surface.ready,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('The 3D scene took too long to start. Try recording again.')),
          SCENE_TIMEOUT_MS,
        );
      }),
    ]);

    const stream = surface.canvas.captureStream(60);
    for (const track of destination.stream.getAudioTracks()) stream.addTrack(track);

    const recorder = new MediaRecorder(stream, {
      mimeType: type,
      videoBitsPerSecond: 8_000_000,
    });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };

    const finished = new Promise<Blob>((resolve, reject) => {
      recorder.onerror = () => reject(new Error('The recording failed part way through.'));
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type });
        // The likeliest failure and the best hidden: with no frames to encode every promise
        // still resolves and the file is simply empty. Saving that would hand someone a
        // video that does not open.
        if (blob.size === 0) reject(new Error('The recording came out empty. Try again.'));
        else resolve(blob);
      };
    });

    recorder.start();
    startedAt = audioContext.currentTime;
    source.start();

    // Driven by the source ending rather than by a timer: the buffer knows exactly how long
    // it is, and a timer would have to agree with it.
    source.onended = () => recorder.state !== 'inactive' && recorder.stop();

    return await finished;
  } finally {
    clearTimeout(timer);
    surface.dispose();
    audioContext.close().catch(() => {});
  }
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
