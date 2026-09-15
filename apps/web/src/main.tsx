import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { GALLERY } from './features/gallery';
import './index.css';

// Lazy, because both cards draw the 3D scene and a static import here would put three.js in
// the bundle every visitor downloads, for a page only the screenshot script ever opens.
const OgCard = lazy(() => import('./OgCard').then((module) => ({ default: module.OgCard })));
const OgCover = lazy(() => import('./OgCover').then((module) => ({ default: module.OgCover })));

const root = document.getElementById('root');
if (!root) throw new Error('#root is missing from index.html');

/**
 * `?og=owner/name` renders that repository's share card alone, at exactly 1200x630, and
 * `?og=cover` the one a link unfurls with when it is not about a repository. Both are for the
 * screenshot script to capture. Not routes: they are a build-time detail rather than an
 * address anyone is meant to visit, and giving them one would put them in the same namespace
 * as the permalinks.
 */
const wanted = new URLSearchParams(window.location.search).get('og');
const card = wanted
  ? GALLERY.find((entry) => `${entry.repo.owner}/${entry.repo.name}` === wanted)
  : undefined;

function page() {
  if (wanted === 'cover') {
    return (
      <Suspense fallback={null}>
        <OgCover />
      </Suspense>
    );
  }
  if (card) {
    return (
      <Suspense fallback={null}>
        <OgCard features={card} />
      </Suspense>
    );
  }
  return <App />;
}

createRoot(root).render(<StrictMode>{page()}</StrictMode>);
