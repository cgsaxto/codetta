import type { RepoFeatures } from '@codetta/schema';
import { MODULE_VOICE_ORDER, moduleVoiceCount } from '../music/arrangement';
import { barToTick, VOICE_ORDER, type Score, type VoiceId } from '../music/score';
import type { Activity, ActivityReader } from './activity';

/**
 * The numbers behind the 3D scene, with no three.js in them.
 *
 * SpatialField applies these to meshes; everything it applies is decided here. The split is
 * the one that makes the scene testable at all. The first version read an FFT inside
 * `useFrame` and damped the result frame by frame, and it shipped measurably static — 0.36% of
 * the canvas changed between silence and playback — with nothing in the suite able to notice,
 * because nothing in the suite could reach a number that lived inside a render callback.
 *
 * Every function here is a pure function of the score and a position in ticks. That is also
 * the precondition for the card and the video to show this scene: a still has no audio to
 * analyse and a recording drops frames, so a picture that depended on either could not be
 * reproduced by them.
 */

export type ViewMode = 'pillars' | 'nodes';

/**
 * The colour behind the scene. Here rather than beside the three.js code, because the card
 * draws a scrim that has to fade into exactly this and the card has no business importing a
 * renderer to find out what it is.
 */
export const SCENE_BACKGROUND = '#050810';

/** What the HUD shows. The same shape the analyser used to report, so the HUD did not change. */
export interface SpectrumBands {
  low: number;
  mid: number;
  high: number;
  energy: number;
  progress: number;
}

export interface Pillar {
  baseHeight: number;
  /** Index into `features.modules`, which is what places and colours it. */
  module: number;
  /**
   * The voice this file's module plays, or null when the module is past the voice count.
   * Such a file is drawn and never moves, which is the truth about it: it is in the
   * repository and it is not in the music.
   */
  voice: VoiceId | null;
  x: number;
  z: number;
}

export interface SphereNode {
  module: number;
  voice: VoiceId | null;
  position: readonly [number, number, number];
}

/** Evenly spaced representatives per module, so one huge module cannot push the rest off frame. */
const PILLARS_PER_MODULE = 18;

/**
 * The voice each module plays, by path.
 *
 * Only the modules that became voices. One past the voice count is in the document and is
 * not playing, and it has no entry here — which is how a pillar finds out that it belongs to
 * the repository and not to the music.
 */
export function moduleVoices(features: RepoFeatures): Map<string, VoiceId> {
  const count = Math.min(moduleVoiceCount(features), features.modules.length);
  return new Map(
    features.modules
      .slice(0, count)
      .map((module, rank) => [module.path, MODULE_VOICE_ORDER[rank] ?? 'lead']),
  );
}

export function pillarsFor(features: RepoFeatures): Pillar[] {
  const voices = moduleVoices(features);
  const moduleNames = features.modules.map((module) => module.path);

  // A large repository can put nearly all 256 timeline entries in one module. Drawing every
  // one makes that lane dozens of world-units long and forces the useful geometry out of
  // frame. Keep evenly spaced representatives rather than a prefix, so the whole module
  // remains legible while every lane stays within one shared spatial budget.
  const timeline = moduleNames.flatMap((path) => {
    const entries = features.timeline.filter((entry) => entry.modulePath === path);
    if (entries.length <= PILLARS_PER_MODULE) return entries;
    return Array.from({ length: PILLARS_PER_MODULE }, (_, index) => {
      const at = Math.round((index / (PILLARS_PER_MODULE - 1)) * (entries.length - 1));
      return entries[at]!;
    });
  });

  const longest = Math.max(1, ...timeline.map((entry) => entry.linesOfCode));
  const rowsPerModule = new Map(
    moduleNames.map((path) => [
      path,
      timeline.filter((entry) => entry.modulePath === path).length,
    ]),
  );
  const placed = new Map<string, number>();

  return timeline.map((entry) => {
    const module = Math.max(0, moduleNames.indexOf(entry.modulePath));
    const row = placed.get(entry.modulePath) ?? 0;
    placed.set(entry.modulePath, row + 1);
    const rows = rowsPerModule.get(entry.modulePath) ?? 1;

    return {
      baseHeight: 0.35 + Math.sqrt(entry.linesOfCode / longest) * 2.65,
      module,
      voice: voices.get(entry.modulePath) ?? null,
      x: (module - (Math.max(1, moduleNames.length) - 1) / 2) * 1.08,
      z: (row - (rows - 1) / 2) * 0.46 + ((module % 2) * 0.16 - 0.08),
    };
  });
}

export function sphereNodesFor(features: RepoFeatures): SphereNode[] {
  const voices = moduleVoices(features);
  const count = Math.min(72, Math.max(28, features.timeline.length));
  const modules = Math.max(1, features.modules.length);
  const golden = Math.PI * (3 - Math.sqrt(5));

  return Array.from({ length: count }, (_, index) => {
    const y = 1 - (index / Math.max(1, count - 1)) * 2;
    const radial = Math.sqrt(Math.max(0, 1 - y * y));
    const angle = index * golden;
    const radius = 3.65 + ((index % 5) - 2) * 0.07;
    const module = index % modules;
    const path = features.modules[module]?.path;

    return {
      module,
      voice: (path !== undefined && voices.get(path)) || null,
      position: [
        Math.cos(angle) * radial * radius,
        y * radius,
        Math.sin(angle) * radial * radius,
      ],
    };
  });
}

/**
 * Slow motion, as whole cycles per playthrough rather than as a rate.
 *
 * A rate in radians per second is the obvious way to write a rotation and it breaks at the
 * loop point: position in ticks wraps back to zero, and a sphere that has turned for eighty
 * seconds snaps back to where it started, once a loop, on every repository. Counting cycles
 * over the piece makes the first frame and the frame after the last one the same frame.
 */
const IDLE_CYCLES = 9;

/** A breath added to every pillar's height, as a fraction of it. */
const IDLE_DEPTH = 0.025;

export interface SceneFrame {
  /** 0–1 through the piece. 0 at rest. */
  progress: number;
  activity: Activity;
  /** 0–2 × IDLE_DEPTH. */
  idle: number;
  sphereYaw: number;
  sphereTilt: number;
  particleYaw: number;
  particleOpacity: number;
  particleSize: number;
}

const SILENT: Activity = {
  voices: Object.fromEntries(VOICE_ORDER.map((voice) => [voice, 0])) as Record<VoiceId, number>,
  low: 0,
  mid: 0,
  high: 0,
  energy: 0,
};

/**
 * The whole scene at one position. `tick` is null when nothing is playing, which is a
 * resting state rather than tick zero — tick zero is the pad and bass striking, and a stopped
 * piece is not the first beat of one.
 */
export function sceneFrame(
  reader: ActivityReader,
  score: Score,
  tick: number | null,
  reduceMotion: boolean,
): SceneFrame {
  const totalTicks = barToTick(score.bars);
  const resting = tick === null || !Number.isFinite(tick) || totalTicks <= 0;
  const progress = resting ? 0 : (((tick % totalTicks) + totalTicks) % totalTicks) / totalTicks;
  const activity = resting ? SILENT : reader.at(tick);
  const turn = progress * Math.PI * 2;

  return {
    progress,
    activity,
    idle: reduceMotion ? 0 : (Math.sin(turn * IDLE_CYCLES) + 1) * IDLE_DEPTH,
    // One turn per playthrough is about 0.08 rad/s, close to the rate the sphere used to
    // drift at, and it closes on itself.
    sphereYaw: reduceMotion ? 0 : turn,
    sphereTilt: reduceMotion ? 0 : Math.sin(turn * 2) * 0.035,
    // An oscillation rather than a turn: a starfield visibly spinning once a minute reads as
    // the camera moving, which it is not.
    particleYaw: reduceMotion ? 0 : Math.sin(turn) * 0.3,
    // Energy is the share of the arrangement sounding, and in practice it lives between about
    // a tenth and a half — the weights are set against that range rather than against 0–1.
    particleOpacity: Math.min(0.75, 0.22 + activity.energy * 0.9),
    particleSize: 0.024 + activity.high * 0.03,
  };
}

function levelOf(voice: VoiceId | null, activity: Activity): number {
  return voice === null ? 0 : (activity.voices[voice] ?? 0);
}

/**
 * How far a struck pillar grows. Enough to read as a hit from across a room, not so much that
 * the tallest file in the repository leaves the top of the frame — the camera is framed for
 * base heights up to three units, and this tops out below twice that.
 */
const PILLAR_REACH = 0.9;

export function pillarHeight(pillar: Pillar, frame: SceneFrame): number {
  return (
    pillar.baseHeight * (1 + levelOf(pillar.voice, frame.activity) * PILLAR_REACH + frame.idle)
  );
}

/**
 * How much brighter a fully struck element is than one at rest, as a multiplier on its colour.
 *
 * A multiplier rather than a mix toward white, which is what this was. Mixing toward white
 * is the obvious way to light something and it erases the one thing the palette is for: at a
 * peak every sounding pillar slid toward the same pale grey, so two repositories 45 degrees
 * apart on the hue wheel looked most alike at exactly the moment the card is a picture of.
 * Scaling a colour in linear light changes how bright it is and leaves which colour it is
 * alone. The renderer's tone mapping rolls the brightest values off, so this is a ceiling on
 * intent rather than on pixels.
 */
const LIT_GAIN = 1.1;

function gainOf(voice: VoiceId | null, activity: Activity): number {
  return 1 + levelOf(voice, activity) * LIT_GAIN;
}

/** The brightness of a pillar's colour: exactly 1 at rest, so a silent scene is the palette. */
export function pillarGain(pillar: Pillar, frame: SceneFrame): number {
  return gainOf(pillar.voice, frame.activity);
}

export function nodeScale(node: SphereNode, frame: SceneFrame): number {
  return 0.7 + levelOf(node.voice, frame.activity) * 1.1;
}

export function nodeGain(node: SphereNode, frame: SceneFrame): number {
  return gainOf(node.voice, frame.activity);
}

export function bandsOf(frame: SceneFrame): SpectrumBands {
  const { low, mid, high, energy } = frame.activity;
  return { low, mid, high, energy, progress: frame.progress };
}
