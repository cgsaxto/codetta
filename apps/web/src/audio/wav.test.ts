import { describe, expect, it } from 'vitest';
import { encodeWav } from './wav';

function read(buffer: ArrayBuffer) {
  const view = new DataView(buffer);
  const ascii = (at: number, length: number) =>
    String.fromCharCode(...new Uint8Array(buffer, at, length));
  const channels = view.getUint16(22, true);

  return {
    riff: ascii(0, 4),
    riffSize: view.getUint32(4, true),
    wave: ascii(8, 4),
    fmt: ascii(12, 4),
    fmtSize: view.getUint32(16, true),
    format: view.getUint16(20, true),
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    bytesPerSecond: view.getUint32(28, true),
    blockAlign: view.getUint16(32, true),
    bits: view.getUint16(34, true),
    data: ascii(36, 4),
    dataSize: view.getUint32(40, true),
    sampleAt: (frame: number, channel: number) =>
      view.getInt16(44 + (frame * channels + channel) * 2, true),
  };
}

describe('encodeWav', () => {
  const stereo = {
    sampleRate: 48000,
    channels: [new Float32Array([0, 0.5, -0.5]), new Float32Array([1, -1, 0])],
  };

  it('writes a header every player recognises', () => {
    const wav = read(encodeWav(stereo));

    expect(wav.riff).toBe('RIFF');
    expect(wav.wave).toBe('WAVE');
    expect(wav.fmt).toBe('fmt ');
    expect(wav.data).toBe('data');
    expect(wav.format).toBe(1);
    expect(wav.fmtSize).toBe(16);
    expect(wav.bits).toBe(16);
    expect(wav.channels).toBe(2);
    expect(wav.sampleRate).toBe(48000);
  });

  it('agrees with itself about how long the file is', () => {
    // The two length fields are the classic way to produce a file that plays in one program
    // and not another, because players differ on how much they trust each of them.
    const buffer = encodeWav(stereo);
    const wav = read(buffer);

    expect(wav.dataSize).toBe(3 * 2 * 2);
    expect(wav.riffSize).toBe(buffer.byteLength - 8);
    expect(buffer.byteLength).toBe(44 + wav.dataSize);
    expect(wav.blockAlign).toBe(4);
    expect(wav.bytesPerSecond).toBe(48000 * 4);
  });

  it('interleaves the channels rather than laying them end to end', () => {
    const wav = read(encodeWav(stereo));

    // Frame 0 is left 0 then right +1; a file written channel-by-channel would put the whole
    // left side first and play as two mono halves.
    expect(wav.sampleAt(0, 0)).toBe(0);
    expect(wav.sampleAt(0, 1)).toBe(32767);
    expect(wav.sampleAt(1, 1)).toBe(-32768);
  });

  it('reaches full scale in both directions without clipping either', () => {
    // Signed 16-bit runs to −32768 but only to 32767. Scaling both by 32768 clips every peak
    // that reaches full scale; scaling both by 32767 wastes a step and biases the waveform.
    const wav = read(
      encodeWav({ sampleRate: 44100, channels: [new Float32Array([1, -1, 0])] }),
    );
    expect(wav.sampleAt(0, 0)).toBe(32767);
    expect(wav.sampleAt(1, 0)).toBe(-32768);
    expect(wav.sampleAt(2, 0)).toBe(0);
  });

  it('clamps a sample that overshoots instead of wrapping it', () => {
    // A limiter sits at the end of the master chain, so this should not arise — and if it
    // ever does, a wrapped sample is a full-scale click in the opposite direction, which is
    // the loudest possible way to fail.
    const wav = read(encodeWav({ sampleRate: 44100, channels: [new Float32Array([2, -3])] }));
    expect(wav.sampleAt(0, 0)).toBe(32767);
    expect(wav.sampleAt(1, 0)).toBe(-32768);
  });

  it('writes a valid, empty file for a score with no samples', () => {
    const buffer = encodeWav({ sampleRate: 44100, channels: [new Float32Array(0)] });
    expect(buffer.byteLength).toBe(44);
    expect(read(buffer).dataSize).toBe(0);
  });

  it('refuses input it cannot describe honestly', () => {
    // A header that disagrees with its payload produces a file that plays as noise rather
    // than one that fails to open, which is far harder to diagnose.
    expect(() => encodeWav({ sampleRate: 44100, channels: [] })).toThrow(/channel/);
    expect(() => encodeWav({ sampleRate: 0, channels: [new Float32Array(1)] })).toThrow(
      /sample rate/,
    );
    expect(() =>
      encodeWav({
        sampleRate: 44100,
        channels: [new Float32Array(4), new Float32Array(3)],
      }),
    ).toThrow(/same number/);
  });
});
