/**
 * PCM samples to a RIFF/WAVE file.
 *
 * Written out rather than pulled in, because the whole encoder is a 44-byte header and a
 * loop: a dependency for this would be more to audit than to write. Pure, so the parts that
 * are easy to get subtly wrong — the byte order, the header's two competing length fields,
 * what happens to a sample outside ±1 — are things a test can hold.
 */

/** 16-bit PCM. Two bytes a sample, which is what every player everywhere reads. */
const BYTES_PER_SAMPLE = 2;
const HEADER_BYTES = 44;

/** RIFF's format tag for uncompressed integer PCM. */
const FORMAT_PCM = 1;

export interface WavOptions {
  sampleRate: number;
  /** One array per channel, each the same length, samples in −1…1. */
  channels: readonly Float32Array[];
}

export function encodeWav({ sampleRate, channels }: WavOptions): ArrayBuffer {
  const count = channels.length;
  if (count === 0) throw new Error('A WAV needs at least one channel.');
  if (!(sampleRate > 0)) throw new Error(`A WAV needs a real sample rate, got ${sampleRate}.`);

  const frames = channels[0]?.length ?? 0;
  for (const channel of channels) {
    if (channel.length !== frames) {
      throw new Error('Every channel must hold the same number of samples.');
    }
  }

  const blockAlign = count * BYTES_PER_SAMPLE;
  const dataBytes = frames * blockAlign;
  const buffer = new ArrayBuffer(HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);

  let at = 0;
  const ascii = (text: string) => {
    for (const character of text) view.setUint8(at++, character.charCodeAt(0));
  };
  // Little-endian throughout: RIFF is a PC format and every field in it is.
  const u32 = (value: number) => {
    view.setUint32(at, value, true);
    at += 4;
  };
  const u16 = (value: number) => {
    view.setUint16(at, value, true);
    at += 2;
  };

  ascii('RIFF');
  // Everything after this field, not the whole file. Getting it wrong by the four bytes of
  // the field itself is the classic way to produce a file that plays in one program and not
  // another, since players differ on how much they trust it.
  u32(HEADER_BYTES - 8 + dataBytes);
  ascii('WAVE');

  ascii('fmt ');
  u32(16); // Length of this chunk's body, for PCM.
  u16(FORMAT_PCM);
  u16(count);
  u32(sampleRate);
  u32(sampleRate * blockAlign); // Bytes a second.
  u16(blockAlign);
  u16(BYTES_PER_SAMPLE * 8);

  ascii('data');
  u32(dataBytes);

  // Interleaved, frame by frame, which is what the block alignment above promised.
  for (let frame = 0; frame < frames; frame++) {
    for (const channel of channels) {
      const sample = Math.max(-1, Math.min(1, channel[frame] ?? 0));
      // Asymmetric on purpose: signed 16-bit runs to −32768 but only to 32767, and scaling
      // both directions by 32768 clips every peak that reaches full scale.
      view.setInt16(at, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      at += BYTES_PER_SAMPLE;
    }
  }

  return buffer;
}

/**
 * Cut a window out of rendered channels, with the edges eased.
 *
 * Both fades earn their place and they are not the same length.
 *
 * A clip starts in the middle of the piece, which means it starts in the middle of whatever
 * notes were sounding. Beginning at a non-zero sample is a step discontinuity, and a step is
 * a click — the loudest, least musical sound the file can contain, right where a listener's
 * attention is highest. Twenty milliseconds removes it and is far too short to hear as a
 * fade.
 *
 * The end is a different problem. Stopping dead is not a click, because a reverb tail is near
 * silence by then, but it is not an ending either — it reads as the file being truncated,
 * which is exactly what it is. A second and a half reads as a decision.
 */
export function sliceWithFades(
  channels: readonly Float32Array[],
  sampleRate: number,
  startSeconds: number,
  durationSeconds: number,
  fadeInSeconds = 0.02,
  fadeOutSeconds = 1.5,
): Float32Array[] {
  const available = channels[0]?.length ?? 0;
  const from = Math.max(0, Math.min(available, Math.round(startSeconds * sampleRate)));
  const frames = Math.max(
    0,
    Math.min(available - from, Math.round(durationSeconds * sampleRate)),
  );

  // A fade cannot be longer than what it is fading, and the two together cannot overlap —
  // otherwise the ramps multiply and the middle of a short clip comes out quieter than it is.
  const fadeIn = Math.min(Math.round(fadeInSeconds * sampleRate), Math.floor(frames / 2));
  const fadeOut = Math.min(Math.round(fadeOutSeconds * sampleRate), Math.floor(frames / 2));

  return channels.map((channel) => {
    const out = new Float32Array(frames);
    for (let at = 0; at < frames; at++) {
      let gain = 1;
      if (at < fadeIn) gain = at / fadeIn;
      const remaining = frames - 1 - at;
      if (remaining < fadeOut) gain = Math.min(gain, remaining / fadeOut);
      out[at] = (channel[from + at] ?? 0) * gain;
    }
    return out;
  });
}
