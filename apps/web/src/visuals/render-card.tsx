import { createRoot } from 'react-dom/client';
import { CARD_HEIGHT, CARD_WIDTH, cardTick, drawCardOverlay, type CardSubject } from './card';
import { SpatialField } from './SpatialField';
import { SCENE_BACKGROUND } from './spatial';

/** Mount only while saving, so the export never borrows the visitor's camera or audio clock. */
export async function renderSpatialCard(subject: CardSubject, scale: number): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(CARD_WIDTH * scale);
  canvas.height = Math.round(CARD_HEIGHT * scale);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser would not give Codetta a canvas to draw on.');

  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.dataset['cardExport'] = 'true';
  Object.assign(host.style, {
    position: 'fixed',
    left: '-10000px',
    top: '0',
    width: `${CARD_WIDTH}px`,
    height: `${CARD_HEIGHT}px`,
    pointerEvents: 'none',
  });
  document.body.append(host);

  let fail: (cause: Error) => void = () => {};
  const root = createRoot(host, {
    onUncaughtError: () =>
      fail(new Error('This browser could not draw the 3D card. Try another browser.')),
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = cardTick(subject.score);

  try {
    return await new Promise<Blob>((resolve, reject) => {
      fail = reject;
      timer = setTimeout(
        () => reject(new Error('The 3D card took too long to draw. Try saving it again.')),
        15_000,
      );
      const capture = (scene: HTMLCanvasElement) => {
        try {
          context.drawImage(scene, 0, 0, canvas.width, canvas.height);
          drawCardOverlay(context, canvas.width, canvas.height, subject, SCENE_BACKGROUND);
          canvas.toBlob((blob) => {
            if (blob) resolve(blob);
            else reject(new Error('Codetta could not turn the card into an image.'));
          }, 'image/png');
        } catch (cause) {
          reject(cause);
        }
      };

      root.render(
        <SpatialField
          features={subject.features}
          score={subject.score}
          palette={subject.palette}
          mode="pillars"
          position={() => tick}
          frameloop="demand"
          dpr={scale}
          onCapture={capture}
          onCaptureError={() =>
            reject(new Error('This browser could not draw the 3D card. Try another browser.'))
          }
        />,
      );
    });
  } finally {
    clearTimeout(timer);
    root.unmount();
    host.remove();
  }
}
