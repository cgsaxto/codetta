import { afterEach, describe, expect, it, vi } from 'vitest';
import { supportedVideoType, videoFilename } from './record';
import { generateScore } from '../music/generate';
import { GALLERY } from '../features/gallery';

/**
 * The recorder itself needs a canvas, a MediaRecorder and a real audio clock, none of which
 * exist here. What is worth testing without a browser is the negotiation around it: which
 * container gets chosen, and what the file ends up called.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('supportedVideoType', () => {
  it('says so rather than guessing when there is no recorder at all', () => {
    // Safari only gained MediaRecorder recently and some embedded browsers still lack it.
    // Handing such a browser a chosen mime type produces an empty file, not an error.
    vi.stubGlobal('MediaRecorder', undefined);
    expect(supportedVideoType()).toBeUndefined();
  });

  it('prefers mp4, which is the one a phone opens without thinking', () => {
    vi.stubGlobal('MediaRecorder', { isTypeSupported: () => true });
    expect(supportedVideoType()).toMatch(/^video\/mp4/);
  });

  it('falls back to webm rather than failing', () => {
    // What Chrome and Firefox have always produced. A clip in the wrong container is still a
    // clip; no clip is not.
    vi.stubGlobal('MediaRecorder', {
      isTypeSupported: (type: string) => type.startsWith('video/webm'),
    });
    expect(supportedVideoType()).toMatch(/^video\/webm/);
  });

  it('reports nothing when the browser accepts none of them', () => {
    vi.stubGlobal('MediaRecorder', { isTypeSupported: () => false });
    expect(supportedVideoType()).toBeUndefined();
  });
});

describe('videoFilename', () => {
  const score = generateScore(GALLERY[0]!);

  it('names the container it actually produced', () => {
    // A .mp4 that holds webm is a file that will not open on the platform it was named for.
    expect(videoFilename(score, 'psf', 'requests', 'square', 'video/mp4;codecs=avc1')).toMatch(
      /\.mp4$/,
    );
    expect(
      videoFilename(score, 'psf', 'requests', 'square', 'video/webm;codecs=vp9,opus'),
    ).toMatch(/\.webm$/);
  });

  it('carries the commit and the shape', () => {
    // The commit because the music is a function of it: two files from one repository at
    // different commits are different pieces. The shape because someone downloading both
    // should not have them collide in a downloads folder.
    const square = videoFilename(score, 'psf', 'requests', 'square', 'video/mp4');
    const vertical = videoFilename(score, 'psf', 'requests', 'vertical', 'video/mp4');

    expect(square).toContain(score.seed);
    expect(square).toContain('psf-requests');
    expect(square).not.toBe(vertical);
  });
});
