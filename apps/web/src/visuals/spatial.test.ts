import { describe, expect, it } from 'vitest';
import { GALLERY } from '../features/gallery';
import { generateScore } from '../music/generate';
import { barToTick } from '../music/score';
import { prepareActivity } from './activity';
import { MODULE_VOICE_ORDER, moduleVoiceCount } from '../music/arrangement';
import {
  moduleVoices,
  nodeScale,
  nodeGain,
  pillarGain,
  pillarHeight,
  pillarsFor,
  sceneFrame,
  sphereNodesFor,
} from './spatial';

/**
 * The scene's numbers, tested where they can be reached.
 *
 * The version these replace drove the geometry from an FFT inside a render callback, and it
 * was measured static — 0.36% of the canvas changed between silence and playback — with the
 * whole suite passing, because no test could see a value computed there. The properties
 * below are the ones that failure lacked.
 */

const requests = GALLERY.find((entry) => entry.repo.name === 'requests')!;
const score = generateScore(requests);
const reader = prepareActivity(score);
const totalTicks = barToTick(score.bars);

describe('moduleVoices', () => {
  it('names a voice for the modules that are playing, in rank order, and for no others', () => {
    // A module past the voice count is in the document and makes no sound. Giving it a voice
    // would move something on screen in time with music it has no part in.
    for (const features of GALLERY) {
      const voices = moduleVoices(features);
      const playing = Math.min(moduleVoiceCount(features), features.modules.length);

      expect(voices.size, features.repo.name).toBe(playing);
      features.modules.forEach((module, rank) => {
        expect(voices.get(module.path), `${features.repo.name} ${module.path}`).toBe(
          rank < playing ? MODULE_VOICE_ORDER[rank] : undefined,
        );
      });
    }
  });

  it('returns nothing, rather than failing, for a repository with no modules', () => {
    expect(moduleVoices({ ...requests, modules: [], timeline: [] }).size).toBe(0);
    expect(pillarsFor({ ...requests, modules: [], timeline: [] })).toStrictEqual([]);
  });
});

describe('pillarsFor', () => {
  it('gives each file the voice its module plays, and no voice past the voice count', () => {
    const voices = moduleVoices(requests);
    for (const pillar of pillarsFor(requests)) {
      const path = requests.modules[pillar.module]?.path ?? '';
      expect(pillar.voice).toBe(voices.get(path) ?? null);
    }
  });
});

describe('sceneFrame', () => {
  it('rests when nothing is playing, rather than striking the first beat', () => {
    const frame = sceneFrame(reader, score, null, false);
    for (const pillar of pillarsFor(requests)) {
      // Exactly 1, not merely close: a scene at rest is the palette, untouched.
      expect(pillarGain(pillar, frame)).toBe(1);
    }
    expect(frame.progress).toBe(0);
  });

  it('draws the same scene at the same tick, however it got there', () => {
    // The damped version could not: its heights depended on the frames that led up to a
    // moment, so a dropped frame changed the picture and a recorder could not reproduce it.
    const pillars = pillarsFor(requests);
    const heightsAt = (tick: number) =>
      pillars.map((pillar) => pillarHeight(pillar, sceneFrame(reader, score, tick, false)));

    const direct = heightsAt(410.25);
    for (const detour of [0, 900.5, 12, 409]) heightsAt(detour);
    expect(heightsAt(410.25)).toEqual(direct);
  });

  it('closes on itself at the loop point instead of snapping back', () => {
    // A rotation written as radians per second turns for the whole piece and jumps back to
    // zero when position wraps. As whole cycles per playthrough, the end is the start.
    const start = sceneFrame(reader, score, 0, false);
    const end = sceneFrame(reader, score, totalTicks - 1e-6, false);
    // Compared as a direction, not a number: 2π and 0 are the same angle.
    expect(Math.cos(end.sphereYaw)).toBeCloseTo(Math.cos(start.sphereYaw), 4);
    expect(Math.sin(end.sphereYaw)).toBeCloseTo(Math.sin(start.sphereYaw), 4);
    expect(end.sphereTilt).toBeCloseTo(start.sphereTilt, 4);
    expect(end.particleYaw).toBeCloseTo(start.particleYaw, 4);
    expect(end.idle).toBeCloseTo(start.idle, 4);
  });

  it('holds still for anyone who asked for less motion, and still shows what is sounding', () => {
    const tick = 420;
    const calm = sceneFrame(reader, score, tick, true);
    expect([calm.idle, calm.sphereYaw, calm.sphereTilt, calm.particleYaw]).toEqual([
      0, 0, 0, 0,
    ]);

    const lit = pillarsFor(requests).some((pillar) => pillarGain(pillar, calm) > 1);
    expect(lit).toBe(true);
  });
});

describe('lighting', () => {
  it('brightens a sounding element and never dims one', () => {
    // A multiplier on the colour rather than a mix toward white. The mix lit things by
    // erasing their hue, so the repositories looked most alike at the peak — the frame the
    // card is a picture of. Scaling keeps the colour and changes only how bright it is.
    const pillars = pillarsFor(requests);
    const nodes = sphereNodesFor(requests);
    let brightest = 1;

    for (let tick = 0; tick < totalTicks; tick += 7.3) {
      const frame = sceneFrame(reader, score, tick, false);
      for (const gain of [
        ...pillars.map((pillar) => pillarGain(pillar, frame)),
        ...nodes.map((node) => nodeGain(node, frame)),
      ]) {
        expect(gain).toBeGreaterThanOrEqual(1);
        expect(gain).toBeLessThanOrEqual(2.1);
        brightest = Math.max(brightest, gain);
      }
    }
    expect(brightest).toBeGreaterThan(1.8);
  });
});

// Every gallery repository rather than one, because the ways this breaks depend on the shape
// of the repository: a Go project with most of its files at the root, a module past the voice
// count, a voice that is assigned and never generated.
for (const features of GALLERY) {
  describe(`against a whole playthrough of ${features.repo.owner}/${features.repo.name}`, () => {
    const piece = generateScore(features);
    const read = prepareActivity(piece);
    const ticks = barToTick(piece.bars);
    const pillars = pillarsFor(features);
    // A voice that is assigned and never generated — percussion, today — has nothing to show.
    const playing = new Set(piece.events.map((event) => event.voice));
    const voiced = pillars.filter(
      (pillar) => pillar.voice !== null && playing.has(pillar.voice),
    );

    const frames = Array.from({ length: 400 }, (_, index) =>
      sceneFrame(read, piece, (index / 400) * ticks, false),
    );

    it('moves every pillar whose voice plays — the thing the analyser version did not do', () => {
      // Its pillars sampled FFT bins scattered across 0–24 kHz, most of them above anything
      // this music plays, so most of them never rose at all. And a first pass at this one
      // left the texture's pillars rising a quarter at most, because a texture's notes are a
      // fifth as loud as a lead's in the mix — which is why levels are relative to each voice.
      const rose = voiced.filter((pillar) =>
        frames.some((frame) => pillarHeight(pillar, frame) / pillar.baseHeight > 1.4),
      );
      expect(voiced.length).toBeGreaterThan(0);
      expect(rose.length).toBe(voiced.length);
    });

    it('keeps even the tallest pillar inside the frame the camera is set for', () => {
      // The camera is framed for base heights up to three units. A reach that lifts the
      // tallest file past about twice that puts the top of the repository out of shot at
      // every peak.
      const tallest = Math.max(
        ...frames.flatMap((frame) => pillars.map((pillar) => pillarHeight(pillar, frame))),
      );
      expect(tallest).toBeLessThan(6.2);
    });

    it('gives the sphere something to do as well', () => {
      const nodes = sphereNodesFor(features).filter(
        (node) => node.voice !== null && playing.has(node.voice),
      );
      const spread = nodes.map((node) => {
        const scales = frames.map((frame) => nodeScale(node, frame));
        return Math.max(...scales) - Math.min(...scales);
      });
      expect(Math.min(...spread)).toBeGreaterThan(0.4);
    });
  });
}
