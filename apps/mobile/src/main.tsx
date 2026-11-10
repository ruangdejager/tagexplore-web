import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { isIos, isStandalone, registerServiceWorker } from './push.js';
import './styles.css';

/**
 * The app's height, as `--app-h`.
 *
 * Installed on an iPhone, iOS reports a viewport one status bar shorter than
 * the screen the app is actually drawn on, which left a blank band under the
 * tab bar. There the screen's own height is used, but only when the viewport
 * really is short, so a fixed iOS (or any other browser) keeps the plain
 * viewport height. The shell is positioned as page content rather than fixed,
 * because a fixed element is cut off at the short edge.
 */
function syncAppHeight(): void {
  const root = document.documentElement;
  if (!(isIos() && isStandalone())) {
    root.style.removeProperty('--app-h');
    return;
  }
  const portrait = window.innerHeight >= window.innerWidth;
  const screenH = portrait ? Math.max(screen.width, screen.height) : Math.min(screen.width, screen.height);
  root.style.setProperty('--app-h', `${Math.max(window.innerHeight, screenH)}px`);
  // Nothing should be scrolled; if iOS nudged the page, put it back.
  if (window.scrollY !== 0) window.scrollTo(0, 0);
}
syncAppHeight();
window.addEventListener('resize', syncAppHeight);
window.addEventListener('orientationchange', () => setTimeout(syncAppHeight, 300));

// The app's own code is running, so the boot watchdog in index.html may reload
// again next time it's needed.
try {
  sessionStorage.removeItem('tx-boot-retry');
} catch {
  // Storage blocked; the watchdog then never reloads, which is fine.
}
// A lazily loaded chunk from a deploy that has since been replaced: reload to
// pick up the new one rather than leaving a half-loaded page.
window.addEventListener('vite:preloadError', () => window.location.reload());

const container = document.getElementById('root');
if (!container) throw new Error('No #root element to mount into.');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

void registerServiceWorker();
