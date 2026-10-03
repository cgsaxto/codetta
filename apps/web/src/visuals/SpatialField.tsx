import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { RepoFeatures } from '@codetta/schema';
import type { Score } from '../music/score';
import { prepareActivity } from './activity';
import type { Palette } from './palette';
import {
  bandsOf,
  nodeGain,
  nodeScale,
  pillarGain,
  pillarHeight,
  pillarsFor,
  SCENE_BACKGROUND,
  sceneFrame,
  sphereNodesFor,
  type SceneFrame,
  type SpectrumBands,
  type ViewMode,
} from './spatial';

export type { SpectrumBands, ViewMode } from './spatial';

interface SpatialFieldProps {
  features: RepoFeatures;
  mode: ViewMode;
  palette: Palette;
  score: Score;
  /**
   * Where the piece is, in ticks, or null when nothing is playing. Called once a frame and
   * never stored, so whoever owns the clock decides what time it is — the page's audio
   * transport today, and a recorder's buffer or a card's fixed frame once those draw this
   * scene too.
   */
  position: () => number | null;
  /**
   * Passed in rather than inferred from whether something is playing, because the case where
   * inferring it goes wrong is the one that matters most. A recording stops live playback
   * first; a scene that switched to `demand` when playback stopped would give the recorder no
   * frames, and MediaRecorder turns no frames into a zero-byte file without an error.
   */
  frameloop?: 'always' | 'demand' | 'never';
  /**
   * A multiplier on how far back the camera sits, 1 by default. Below 1 is closer.
   *
   * The framing is chosen for a scene someone can orbit, which means leaving room around it.
   * A tile on the cover is 273px wide and nobody orbits it; the same room there is most of
   * the picture spent on empty space, at the size where there is least picture to spend.
   */
  cameraDistance?: number;
  /** Device pixel ratio. The page caps it for speed; a screenshot wants every pixel. */
  dpr?: number | [number, number];
  onSpectrum?: (bands: SpectrumBands) => void;
  /**
   * Called once, after the scene has drawn with the inputs it was given. Exists for the
   * screenshot script, which would otherwise capture whatever the canvas held when the page
   * finished loading — on a cold start, nothing.
   */
  onReady?: () => void;
  /** Copy the rendered frame before WebGL releases its drawing buffer. */
  onCapture?: (canvas: HTMLCanvasElement) => void;
  onCaptureError?: (cause: Error) => void;
  /**
   * Called after every frame is drawn, with the canvas still holding it. The recorder's hook:
   * it copies each frame onto the surface it is capturing, for the same reason `onCapture`
   * copies its one — read any later and the drawing buffer may already be cleared.
   */
  onFrame?: (canvas: HTMLCanvasElement) => void;
}

interface SceneProps extends SpatialFieldProps {
  reduceMotion: boolean;
}

type FrameRef = RefObject<SceneFrame>;

const FALLBACK_ACCENT = '#9be7ff';

function moduleColour(palette: Palette, module: number): string {
  return (
    palette.modules[module % palette.modules.length] ?? palette.modules[0] ?? FALLBACK_ACCENT
  );
}

function Pillars({
  features,
  palette,
  frame,
}: {
  features: RepoFeatures;
  palette: Palette;
  frame: FrameRef;
}) {
  const mesh = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const colour = useMemo(() => new THREE.Color(), []);
  const pillars = useMemo(() => pillarsFor(features), [features]);

  useFrame(() => {
    const current = mesh.current;
    if (!current) return;
    const now = frame.current;

    pillars.forEach((pillar, index) => {
      const height = pillarHeight(pillar, now);
      dummy.position.set(pillar.x, height / 2 - 1.2, pillar.z);
      dummy.scale.set(0.25, height, 0.25);
      dummy.rotation.y = (pillar.module % 3) * 0.08;
      dummy.updateMatrix();
      current.setMatrixAt(index, dummy.matrix);

      colour.set(moduleColour(palette, pillar.module)).multiplyScalar(pillarGain(pillar, now));
      current.setColorAt(index, colour);
    });

    current.instanceMatrix.needsUpdate = true;
    if (current.instanceColor) current.instanceColor.needsUpdate = true;
  });

  return (
    <group rotation={[0, -0.12, 0]}>
      <instancedMesh ref={mesh} args={[undefined, undefined, pillars.length]}>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial
          roughness={0.23}
          metalness={0.42}
          transparent
          opacity={0.9}
          emissive={palette.modules[0] ?? FALLBACK_ACCENT}
          emissiveIntensity={0.16}
        />
      </instancedMesh>
      <mesh position={[0, -1.22, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[5.9, 72]} />
        <meshBasicMaterial color={palette.ground} transparent opacity={0.38} />
      </mesh>
      {[2.1, 3.8, 5.5].map((radius) => (
        <mesh key={radius} position={[0, -1.2, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[radius, radius + 0.008, 96]} />
          <meshBasicMaterial color={palette.quiet} transparent opacity={0.32} />
        </mesh>
      ))}
    </group>
  );
}

function NodeSphere({
  features,
  palette,
  frame,
}: {
  features: RepoFeatures;
  palette: Palette;
  frame: FrameRef;
}) {
  const mesh = useRef<THREE.InstancedMesh>(null);
  const group = useRef<THREE.Group>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const colour = useMemo(() => new THREE.Color(), []);
  const nodes = useMemo(() => sphereNodesFor(features), [features]);

  const edgePositions = useMemo(() => {
    const positions: number[] = [];
    nodes.forEach((node, index) => {
      for (const offset of [1, 3]) {
        const next = nodes[(index + offset) % nodes.length];
        if (!next) continue;
        positions.push(...node.position, ...next.position);
      }
    });
    return new Float32Array(positions);
  }, [nodes]);

  useFrame(() => {
    const current = mesh.current;
    if (!current) return;
    const now = frame.current;

    nodes.forEach((node, index) => {
      dummy.position.set(...node.position);
      dummy.scale.setScalar(nodeScale(node, now));
      dummy.updateMatrix();
      current.setMatrixAt(index, dummy.matrix);

      colour.set(moduleColour(palette, node.module)).multiplyScalar(nodeGain(node, now));
      current.setColorAt(index, colour);
    });

    group.current?.rotation.set(now.sphereTilt, now.sphereYaw, 0);
    current.instanceMatrix.needsUpdate = true;
    if (current.instanceColor) current.instanceColor.needsUpdate = true;
  });

  return (
    <group ref={group}>
      <lineSegments>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[edgePositions, 3]} />
        </bufferGeometry>
        <lineBasicMaterial color={palette.quiet} transparent opacity={0.2} />
      </lineSegments>
      <instancedMesh ref={mesh} args={[undefined, undefined, nodes.length]}>
        <sphereGeometry args={[0.105, 18, 18]} />
        <meshStandardMaterial
          roughness={0.18}
          metalness={0.34}
          emissive={palette.modules[0] ?? FALLBACK_ACCENT}
          emissiveIntensity={0.32}
        />
      </instancedMesh>
    </group>
  );
}

function ParticleField({ palette, frame }: { palette: Palette; frame: FrameRef }) {
  const points = useRef<THREE.Points>(null);
  const material = useRef<THREE.PointsMaterial>(null);
  const positions = useMemo(() => {
    let state = Number.parseInt(palette.modules[0]?.slice(1, 7) ?? '3f82ff', 16) || 1;
    const random = () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0xffffffff;
    };
    return Float32Array.from({ length: 360 * 3 }, () => (random() - 0.5) * 22);
  }, [palette]);

  useFrame(() => {
    const now = frame.current;
    if (points.current) points.current.rotation.y = now.particleYaw;
    if (material.current) {
      material.current.opacity = now.particleOpacity;
      material.current.size = now.particleSize;
    }
  });

  return (
    <points ref={points}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial
        ref={material}
        color={palette.modules[1] ?? palette.modules[0] ?? FALLBACK_ACCENT}
        size={0.024}
        sizeAttenuation
        transparent
        opacity={0.22}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  );
}

function ReadySignal({ onReady }: { onReady?: (() => void) | undefined }) {
  const invalidate = useThree((state) => state.invalidate);
  const frames = useRef(0);
  const fired = useRef(false);

  useFrame(() => {
    if (!onReady || fired.current) return;
    frames.current += 1;
    // A frame callback runs before that frame is drawn, so the first one cannot be the signal:
    // it would report a canvas that is still empty. Ask for one more frame and report from
    // inside it, by which point the first has been drawn. Asking works under `demand` too,
    // where nothing else would ever schedule a second frame.
    if (frames.current === 1) {
      invalidate();
      return;
    }
    fired.current = true;
    onReady();
  });
  return null;
}

function FrameCapture({ capture }: { capture: (canvas: HTMLCanvasElement) => void }) {
  const frames = useRef(0);

  useFrame(({ gl, scene, camera, invalidate }) => {
    // Positive priority owns the draw, so the copy happens synchronously after it. Waiting
    // for a timer or an effect instead can read a cleared WebGL buffer and save a black card.
    gl.render(scene, camera);
    frames.current += 1;
    if (frames.current === 1) invalidate();
    else if (frames.current === 2) capture(gl.domElement);
  }, 1);

  return null;
}

function FramePump({ pump }: { pump: (canvas: HTMLCanvasElement) => void }) {
  useFrame(({ gl, scene, camera }) => {
    gl.render(scene, camera);
    pump(gl.domElement);
  }, 1);

  return null;
}

function SpectrumReporter({
  frame,
  onSpectrum,
}: {
  frame: FrameRef;
  onSpectrum?: SceneProps['onSpectrum'];
}) {
  const lastReport = useRef(-Infinity);

  useFrame(() => {
    if (!onSpectrum) return;
    // Wall-clock throttling is fine here and nowhere else in this file: it decides how often
    // the HUD is told, never what the scene looks like.
    const now = performance.now();
    if (now - lastReport.current < 100) return;
    lastReport.current = now;
    onSpectrum(bandsOf(frame.current));
  });
  return null;
}

/**
 * How far back the camera sits, as a multiple of the landscape framing.
 *
 * A portrait canvas has far less horizontal field of view, so the same scene is pulled back
 * to keep the repository inside the frame rather than cropping its first and last modules.
 */
function useFraming(distance: number): number {
  const width = useThree((state) => state.size.width);
  const height = useThree((state) => state.size.height);
  const aspect = width / Math.max(1, height);
  return (aspect < 0.82 ? 1.45 : aspect < 1.2 ? 1.24 : 1) * distance;
}

function CameraRig({ framing }: { framing: number }) {
  const camera = useThree((state) => state.camera);
  const gl = useThree((state) => state.gl);
  const invalidate = useThree((state) => state.invalidate);
  const controls = useMemo(() => new OrbitControls(camera, gl.domElement), [camera, gl]);

  useEffect(() => {
    camera.position.set(8.4 * framing, 5.2 * framing, 10.2 * framing);
    camera.lookAt(0, 0, 0);
    controls.target.set(0, 0, 0);
    controls.enableDamping = true;
    controls.dampingFactor = 0.055;
    controls.enablePan = false;
    controls.enableRotate = true;
    controls.enableZoom = true;
    controls.rotateSpeed = 0.62;
    controls.zoomSpeed = 0.72;
    controls.minDistance = 5.2 * framing;
    controls.maxDistance = 18 * framing;
    controls.minPolarAngle = 0.18;
    controls.maxPolarAngle = Math.PI - 0.22;
    controls.update();

    const reset = () => {
      camera.position.set(8.4 * framing, 5.2 * framing, 10.2 * framing);
      controls.target.set(0, 0, 0);
      camera.lookAt(controls.target);
      controls.update();
      invalidate();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const offset = camera.position.clone().sub(controls.target);
      const spherical = new THREE.Spherical().setFromVector3(offset);
      let handled = true;

      switch (event.key) {
        case 'ArrowLeft':
          spherical.theta -= 0.12;
          break;
        case 'ArrowRight':
          spherical.theta += 0.12;
          break;
        case 'ArrowUp':
          spherical.phi -= 0.08;
          break;
        case 'ArrowDown':
          spherical.phi += 0.08;
          break;
        case '+':
        case '=':
          spherical.radius *= 0.88;
          break;
        case '-':
        case '_':
          spherical.radius *= 1.12;
          break;
        case 'Home':
        case '0':
          reset();
          event.preventDefault();
          return;
        default:
          handled = false;
      }

      if (!handled) return;
      event.preventDefault();
      spherical.phi = THREE.MathUtils.clamp(
        spherical.phi,
        controls.minPolarAngle,
        controls.maxPolarAngle,
      );
      spherical.radius = THREE.MathUtils.clamp(
        spherical.radius,
        controls.minDistance,
        controls.maxDistance,
      );
      offset.setFromSpherical(spherical);
      camera.position.copy(controls.target).add(offset);
      camera.lookAt(controls.target);
      controls.update();
      invalidate();
    };

    const invalidateOnChange = () => invalidate();
    controls.addEventListener('change', invalidateOnChange);
    gl.domElement.addEventListener('keydown', onKeyDown);
    return () => {
      controls.removeEventListener('change', invalidateOnChange);
      gl.domElement.removeEventListener('keydown', onKeyDown);
      controls.dispose();
    };
  }, [camera, controls, framing, gl, invalidate]);

  useFrame(() => controls.update(), -1);
  return null;
}

function CanvasAccessibility({
  label,
  descriptionId,
}: {
  label: string;
  descriptionId: string;
}) {
  const canvas = useThree((state) => state.gl.domElement);

  useEffect(() => {
    canvas.tabIndex = 0;
    canvas.setAttribute('aria-describedby', descriptionId);
    canvas.setAttribute('aria-label', label);
  }, [canvas, descriptionId, label]);

  return null;
}

function Scene(props: SceneProps) {
  const { features, mode, onReady, onSpectrum, palette, position, reduceMotion, score } = props;
  const reader = useMemo(() => prepareActivity(score), [score]);
  const invalidate = useThree((state) => state.invalidate);
  const framing = useFraming(props.cameraDistance ?? 1);
  const frame = useRef<SceneFrame>(sceneFrame(reader, score, null, reduceMotion));

  // Read once per frame, before anything draws, so every part of the scene is looking at the
  // same instant rather than each asking the audio clock for itself a few microseconds apart.
  // Negative priority on purpose: in react-three-fiber a positive one takes over rendering.
  useFrame(() => {
    frame.current = sceneFrame(reader, score, position(), reduceMotion);
  }, -2);

  // A scene on `demand` only draws when told to. Stopping playback swaps `position` for one
  // that answers null, and without this the canvas would keep the last frame of the piece
  // rather than coming to rest.
  useEffect(() => {
    invalidate();
  }, [invalidate, position, mode, reduceMotion, reader]);

  return (
    <>
      <color attach="background" args={[SCENE_BACKGROUND]} />
      {/*
        Fog is measured from the camera, so its range has to move with the camera. Fixed at
        10–25 it was right for a landscape frame and wrong for every other: a square frame
        sits the camera a quarter further back and a portrait one nearly half, which put the
        whole repository deep in the fog. The scene was dimmer on a phone than on a laptop,
        and dimmest of all in a vertical video.
      */}
      <fog attach="fog" args={[SCENE_BACKGROUND, 10 * framing, 25 * framing]} />
      <ambientLight intensity={0.58} />
      <directionalLight
        position={[5, 8, 7]}
        intensity={2.1}
        color={palette.modules[0] ?? FALLBACK_ACCENT}
      />
      <pointLight
        position={[-6, 1, -4]}
        intensity={30}
        distance={14}
        color={palette.modules[2] ?? palette.modules[0] ?? FALLBACK_ACCENT}
      />
      <ParticleField palette={palette} frame={frame} />
      {mode === 'pillars' ? (
        <Pillars features={features} palette={palette} frame={frame} />
      ) : (
        <NodeSphere features={features} palette={palette} frame={frame} />
      )}
      <SpectrumReporter frame={frame} onSpectrum={onSpectrum} />
      <ReadySignal onReady={onReady} />
      <CameraRig framing={framing} />
      {props.onCapture && <FrameCapture capture={props.onCapture} />}
      {props.onFrame && <FramePump pump={props.onFrame} />}
    </>
  );
}

export function SpatialField(props: SpatialFieldProps) {
  const [reduceMotion, setReduceMotion] = useState(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduceMotion(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  const descriptionId = `spatial-help-${props.features.repo.commitSha.slice(0, 8)}`;
  const label = `${props.features.repo.owner}/${props.features.repo.name} interactive 3D audio visualisation`;
  // A scene mounted to be copied from is never seen or operated, so it should not announce
  // itself to a screen reader or take a place in the tab order.
  const offscreen = Boolean(props.onCapture ?? props.onFrame);

  return (
    <>
      {!offscreen && (
        <p id={descriptionId} className="sr-only">
          Interactive repository topology. Drag to orbit, use the mouse wheel or plus and minus
          keys to zoom, arrow keys to rotate, and Home to reset the view.
        </p>
      )}
      <Canvas
        camera={{ position: [8.4, 5.2, 10.2], fov: 42, near: 0.1, far: 80 }}
        dpr={props.dpr ?? [1, 1.5]}
        frameloop={props.frameloop ?? 'demand'}
        gl={
          props.onCaptureError
            ? (
                defaults: Omit<THREE.WebGLRendererParameters, 'canvas'> & { canvas: unknown },
              ) => {
                try {
                  return new THREE.WebGLRenderer({
                    ...defaults,
                    canvas: defaults.canvas as HTMLCanvasElement,
                    antialias: true,
                    alpha: false,
                    powerPreference: 'high-performance',
                  });
                } catch (cause) {
                  props.onCaptureError?.(
                    cause instanceof Error ? cause : new Error(String(cause)),
                  );
                  throw cause;
                }
              }
            : { antialias: true, alpha: false, powerPreference: 'high-performance' }
        }
        aria-label={label}
      >
        {!offscreen && <CanvasAccessibility label={label} descriptionId={descriptionId} />}
        <Scene {...props} reduceMotion={reduceMotion} />
      </Canvas>
    </>
  );
}
