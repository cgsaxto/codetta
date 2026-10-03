import { createRoot } from 'react-dom/client';
import { drawCardOverlay, type CardSubject } from './card';
import { SpatialField } from './SpatialField';
import { SCENE_BACKGROUND, type ViewMode } from './spatial';

/**
 * The surface a recording captures: the page's own 3D scene with the card's text over it.
 *
 * Two canvases, because MediaRecorder takes one stream and there are two things to show. The
 * scene draws on WebGL; every frame is copied onto a 2D canvas the moment it is drawn, the
 * text goes on top, and the 2D canvas is what gets captured. The text is drawn once and
 * stamped, not laid out sixty times a second.
 *
 * Its own scene rather than the one on the page, for the reason the saved card has its own:
 * the page's canvas is whatever size the window is and pointed wherever the visitor has
 * dragged it, and a recording is 1080 wide and the same for everybody.
 */

/** Type on a video is half again the card's. See `drawCardOverlay` for why. */
const TEXT_SCALE = 1.5;

export interface ClipSurface {
  /** What to hand `captureStream`. */
  canvas: HTMLCanvasElement;
  /** Resolves once the surface holds a real frame, so a recording never opens on black. */
  ready: Promise<void>;
  dispose(): void;
}

export interface ClipSurfaceOptions {
  subject: CardSubject;
  mode: ViewMode;
  width: number;
  height: number;
  /** Where the piece is, in ticks. Read once per frame; the recorder owns the clock. */
  position: () => number;
  /** After each composited frame. */
  onFrame?: () => void;
}

export function mountClipSurface(options: ClipSurfaceOptions): ClipSurface {
  const { subject, mode, width, height, position, onFrame } = options;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser would not give Codetta a canvas to draw on.');

  const text = document.createElement('canvas');
  text.width = width;
  text.height = height;
  const textContext = text.getContext('2d');
  if (!textContext) throw new Error('This browser would not give Codetta a canvas to draw on.');
  drawCardOverlay(textContext, width, height, subject, SCENE_BACKGROUND, TEXT_SCALE);

  // Until the first frame arrives the surface is the scene's own ground, not transparent
  // black: a captured stream starts with whatever the canvas holds.
  context.fillStyle = SCENE_BACKGROUND;
  context.fillRect(0, 0, width, height);

  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.dataset['clipExport'] = 'true';
  Object.assign(host.style, {
    position: 'fixed',
    left: '-10000px',
    top: '0',
    width: `${width}px`,
    height: `${height}px`,
    pointerEvents: 'none',
  });
  document.body.append(host);

  let settle: () => void = () => {};
  let fail: (cause: Error) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  // A caller that disposes before awaiting must not leave an unhandled rejection behind.
  ready.catch(() => {});

  const unsupported = () =>
    fail(new Error('This browser could not draw the 3D scene for the video.'));
  const root = createRoot(host, { onUncaughtError: unsupported });

  let frames = 0;
  const compose = (scene: HTMLCanvasElement) => {
    context.drawImage(scene, 0, 0, width, height);
    context.drawImage(text, 0, 0);
    frames += 1;
    // The second frame, as everywhere else this scene is copied from: the first is drawn
    // before the instanced meshes have their matrices.
    if (frames === 2) settle();
    onFrame?.();
  };

  root.render(
    <SpatialField
      features={subject.features}
      score={subject.score}
      palette={subject.palette}
      mode={mode}
      position={position}
      // Always, and stated rather than inferred. Recording stops live playback first; a scene
      // that fell back to `demand` at that moment would hand the recorder no frames, and
      // MediaRecorder turns no frames into a zero-byte file without raising anything.
      frameloop="always"
      // One device pixel per pixel: the surface is already the size of the video.
      dpr={1}
      onFrame={compose}
      onCaptureError={unsupported}
    />,
  );

  return {
    canvas,
    ready,
    dispose() {
      root.unmount();
      host.remove();
    },
  };
}
