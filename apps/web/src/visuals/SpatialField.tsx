import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { RepoFeatures } from '@codetta/schema';
import type { Player } from '../audio/player';
import { scoreDurationSeconds, type Score } from '../music/score';
import type { Palette } from './palette';

export type ViewMode = 'pillars' | 'nodes';

export interface SpectrumBands {
  low: number;
  mid: number;
  high: number;
  energy: number;
  progress: number;
}

interface SpatialFieldProps {
  features: RepoFeatures;
  mode: ViewMode;
  palette: Palette;
  player: Player | null;
  score: Score;
  onSpectrum?: (bands: SpectrumBands) => void;
}

interface SceneProps extends SpatialFieldProps {
  reduceMotion: boolean;
}

interface PillarDatum {
  baseHeight: number;
  module: number;
  x: number;
  z: number;
}

interface NodeDatum {
  module: number;
  position: THREE.Vector3;
}

const SILENCE = new Float32Array(128);
const VISUAL_SPECTRUM = new Float32Array(128);
const SCENE_BACKGROUND = '#050810';
const FALLBACK_ACCENT = '#9be7ff';
const WHITE = new THREE.Color('#ffffff');
let lastSpectrumAt = -1;
let lastSpectrumPlayer: Player | null = null;
let lastSpectrum = {
  values: SILENCE,
  bands: { low: 0, mid: 0, high: 0, energy: 0, progress: 0 },
};

function average(values: Float32Array, from: number, to: number): number {
  const end = Math.min(values.length, to);
  if (from >= end) return 0;
  let sum = 0;
  for (let index = from; index < end; index++) sum += values[index] ?? 0;
  return sum / (end - from);
}

/** Lift quieter musical detail without letting a transient pin the geometry at full scale. */
function visualLevel(value: number): number {
  return Math.min(1, Math.max(0, value) ** 0.42 * 2.1);
}

function spectrumFor(player: Player | null): { values: Float32Array; bands: SpectrumBands } {
  const now = performance.now();
  if (player === lastSpectrumPlayer && now - lastSpectrumAt < 6) return lastSpectrum;

  const raw = player?.spectrum() ?? SILENCE;
  const values = player ? VISUAL_SPECTRUM : SILENCE;
  if (player) {
    const end = Math.min(values.length, raw.length);
    for (let index = 0; index < end; index++) values[index] = visualLevel(raw[index] ?? 0);
    values.fill(0, end);
  }
  const low = average(values, 0, 8);
  const mid = average(values, 8, 32);
  const high = average(values, 32, 72);
  const energy = low * 0.46 + mid * 0.38 + high * 0.16;
  lastSpectrumAt = now;
  lastSpectrumPlayer = player;
  lastSpectrum = { values, bands: { low, mid, high, energy, progress: 0 } };
  return lastSpectrum;
}

function Pillars({
  features,
  palette,
  player,
  reduceMotion,
}: Pick<SceneProps, 'features' | 'palette' | 'player' | 'reduceMotion'>) {
  const mesh = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const colour = useMemo(() => new THREE.Color(), []);
  const heights = useRef<Float32Array>(new Float32Array(0));

  const data = useMemo<PillarDatum[]>(() => {
    const moduleNames = features.modules.map((module) => module.path);
    // A large repository can put nearly all 256 timeline entries in one module. Drawing
    // every one makes that lane dozens of world-units long and forces the useful geometry
    // out of frame. Keep evenly spaced representatives rather than a prefix, so the whole
    // module remains legible while every lane stays within one shared spatial budget.
    const timeline = moduleNames.flatMap((path) => {
      const entries = features.timeline.filter((entry) => entry.modulePath === path);
      const limit = 18;
      if (entries.length <= limit) return entries;
      return Array.from({ length: limit }, (_, index) => {
        const at = Math.round((index / (limit - 1)) * (entries.length - 1));
        return entries[at]!;
      });
    });
    const longest = Math.max(1, ...timeline.map((entry) => entry.linesOfCode));
    const moduleCounts = new Map(
      moduleNames.map((path) => [
        path,
        timeline.filter((entry) => entry.modulePath === path).length,
      ]),
    );
    const perModule = new Map<string, number>();

    return timeline.map((entry) => {
      const module = Math.max(0, moduleNames.indexOf(entry.modulePath));
      const row = perModule.get(entry.modulePath) ?? 0;
      perModule.set(entry.modulePath, row + 1);
      const rows = moduleCounts.get(entry.modulePath) ?? 1;
      const x = (module - (Math.max(1, moduleNames.length) - 1) / 2) * 1.08;
      const z = (row - (rows - 1) / 2) * 0.46 + ((module % 2) * 0.16 - 0.08);
      const baseHeight = 0.35 + Math.sqrt(entry.linesOfCode / longest) * 2.65;
      return { baseHeight, module, x, z };
    });
  }, [features]);

  useEffect(() => {
    heights.current = Float32Array.from(data, (item) => item.baseHeight);
  }, [data]);

  useFrame(({ clock }, delta) => {
    const current = mesh.current;
    if (!current) return;
    const { values } = spectrumFor(player);
    const idle = reduceMotion ? 0 : (Math.sin(clock.elapsedTime * 0.72) + 1) * 0.025;

    data.forEach((item, index) => {
      const bin = values[(index * 3 + item.module * 5) % Math.max(1, values.length)] ?? 0;
      const target = item.baseHeight * (1 + bin * 2.35 + idle);
      const height = THREE.MathUtils.damp(
        heights.current[index] ?? item.baseHeight,
        target,
        10,
        delta,
      );
      heights.current[index] = height;

      dummy.position.set(item.x, height / 2 - 1.2, item.z);
      dummy.scale.set(0.25, height, 0.25);
      dummy.rotation.y = (item.module % 3) * 0.08;
      dummy.updateMatrix();
      current.setMatrixAt(index, dummy.matrix);

      colour
        .set(
          palette.modules[item.module % palette.modules.length] ??
            palette.modules[0] ??
            FALLBACK_ACCENT,
        )
        .lerp(WHITE, Math.min(0.68, bin * 0.75));
      current.setColorAt(index, colour);
    });

    current.instanceMatrix.needsUpdate = true;
    if (current.instanceColor) current.instanceColor.needsUpdate = true;
  });

  return (
    <group rotation={[0, -0.12, 0]}>
      <instancedMesh ref={mesh} args={[undefined, undefined, data.length]}>
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
  player,
  reduceMotion,
}: Pick<SceneProps, 'features' | 'palette' | 'player' | 'reduceMotion'>) {
  const mesh = useRef<THREE.InstancedMesh>(null);
  const group = useRef<THREE.Group>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const colour = useMemo(() => new THREE.Color(), []);
  const scales = useRef<Float32Array>(new Float32Array(0));

  const data = useMemo<NodeDatum[]>(() => {
    const count = Math.min(72, Math.max(28, features.timeline.length));
    const modules = Math.max(1, features.modules.length);
    const golden = Math.PI * (3 - Math.sqrt(5));
    return Array.from({ length: count }, (_, index) => {
      const y = 1 - (index / Math.max(1, count - 1)) * 2;
      const radial = Math.sqrt(Math.max(0, 1 - y * y));
      const angle = index * golden;
      const radius = 3.65 + ((index % 5) - 2) * 0.07;
      return {
        module: index % modules,
        position: new THREE.Vector3(
          Math.cos(angle) * radial * radius,
          y * radius,
          Math.sin(angle) * radial * radius,
        ),
      };
    });
  }, [features]);

  const edgePositions = useMemo(() => {
    const positions: number[] = [];
    data.forEach((node, index) => {
      for (const offset of [1, 3]) {
        const next = data[(index + offset) % data.length];
        if (!next) continue;
        positions.push(...node.position.toArray(), ...next.position.toArray());
      }
    });
    return new Float32Array(positions);
  }, [data]);

  useEffect(() => {
    scales.current = new Float32Array(data.length).fill(1);
  }, [data.length]);

  useFrame(({ clock }, delta) => {
    const current = mesh.current;
    if (!current) return;
    const { values, bands } = spectrumFor(player);

    data.forEach((item, index) => {
      const bin = values[(index * 2 + 4) % Math.max(1, values.length)] ?? 0;
      const target = 0.7 + bin * 1.95;
      const scale = THREE.MathUtils.damp(scales.current[index] ?? 1, target, 11, delta);
      scales.current[index] = scale;
      dummy.position.copy(item.position);
      dummy.scale.setScalar(scale);
      dummy.updateMatrix();
      current.setMatrixAt(index, dummy.matrix);
      colour
        .set(
          palette.modules[item.module % palette.modules.length] ??
            palette.modules[0] ??
            FALLBACK_ACCENT,
        )
        .lerp(WHITE, Math.min(0.72, bin * 0.8));
      current.setColorAt(index, colour);
    });

    if (group.current && !reduceMotion) {
      group.current.rotation.y += delta * (0.025 + bands.energy * 0.12);
      group.current.rotation.x = Math.sin(clock.elapsedTime * 0.12) * 0.035;
    }
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
      <instancedMesh ref={mesh} args={[undefined, undefined, data.length]}>
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

function ParticleField({
  player,
  palette,
  reduceMotion,
}: Pick<SceneProps, 'player' | 'palette' | 'reduceMotion'>) {
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

  useFrame((_, delta) => {
    const { bands } = spectrumFor(player);
    if (points.current && !reduceMotion) {
      points.current.rotation.y += delta * (0.006 + bands.high * 0.045);
      points.current.rotation.x += delta * 0.002;
    }
    if (material.current) {
      material.current.opacity = THREE.MathUtils.damp(
        material.current.opacity,
        0.22 + bands.energy * 0.55,
        7,
        delta,
      );
      material.current.size = THREE.MathUtils.damp(
        material.current.size,
        0.024 + bands.high * 0.055,
        7,
        delta,
      );
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
        size={0.026}
        sizeAttenuation
        transparent
        opacity={0.24}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  );
}

function SpectrumReporter({
  player,
  score,
  onSpectrum,
}: Pick<SceneProps, 'player' | 'score' | 'onSpectrum'>) {
  const lastReport = useRef(0);
  const duration = useMemo(() => scoreDurationSeconds(score), [score]);

  useFrame(({ clock }) => {
    if (!onSpectrum || clock.elapsedTime - lastReport.current < 0.1) return;
    lastReport.current = clock.elapsedTime;
    const { bands } = spectrumFor(player);
    onSpectrum({
      ...bands,
      progress: player ? (player.positionSeconds() % duration) / duration : 0,
    });
  });
  return null;
}

function CameraRig() {
  const camera = useThree((state) => state.camera);
  const gl = useThree((state) => state.gl);
  const width = useThree((state) => state.size.width);
  const height = useThree((state) => state.size.height);
  const invalidate = useThree((state) => state.invalidate);
  const controls = useMemo(() => new OrbitControls(camera, gl.domElement), [camera, gl]);

  useEffect(() => {
    const aspect = width / Math.max(1, height);
    // A portrait canvas has far less horizontal field of view. Pulling the same scene back
    // keeps the repository inside the frame rather than cropping its first and last modules.
    const framing = aspect < 0.82 ? 1.45 : aspect < 1.2 ? 1.24 : 1;
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
  }, [camera, controls, gl, height, invalidate, width]);

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
  return (
    <>
      <color attach="background" args={[SCENE_BACKGROUND]} />
      <fog attach="fog" args={[SCENE_BACKGROUND, 10, 25]} />
      <ambientLight intensity={0.58} />
      <directionalLight
        position={[5, 8, 7]}
        intensity={2.1}
        color={props.palette.modules[0] ?? FALLBACK_ACCENT}
      />
      <pointLight
        position={[-6, 1, -4]}
        intensity={30}
        distance={14}
        color={props.palette.modules[2] ?? props.palette.modules[0] ?? FALLBACK_ACCENT}
      />
      <ParticleField {...props} />
      {props.mode === 'pillars' ? <Pillars {...props} /> : <NodeSphere {...props} />}
      <SpectrumReporter {...props} />
      <CameraRig />
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

  return (
    <>
      <p id={descriptionId} className="sr-only">
        Interactive repository topology. Drag to orbit, use the mouse wheel or plus and minus
        keys to zoom, arrow keys to rotate, and Home to reset the view.
      </p>
      <Canvas
        camera={{ position: [8.4, 5.2, 10.2], fov: 42, near: 0.1, far: 80 }}
        dpr={[1, 1.5]}
        frameloop={props.player ? 'always' : 'demand'}
        gl={{ antialias: true, alpha: false, powerPreference: 'high-performance' }}
        aria-label={label}
      >
        <CanvasAccessibility label={label} descriptionId={descriptionId} />
        <Scene {...props} reduceMotion={reduceMotion} />
      </Canvas>
    </>
  );
}
