import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { OgCard } from './OgCard';
import { OgCover } from './OgCover';
import { GALLERY } from './features/gallery';
import './index.css';

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
  if (wanted === 'cover') return <OgCover />;
  if (card) return <OgCard features={card} />;
  return <App />;
}

createRoot(root).render(<StrictMode>{page()}</StrictMode>);
