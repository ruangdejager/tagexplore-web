import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { isIos, isStandalone, registerServiceWorker } from './push.js';
import './styles.css';

/**
 * The app's height, set as `--app-h`.
 *
 * Installed on an iPhone (with the translucent status bar), WebKit can lay
 * the page out one status bar shorter than the screen it actually draws on,
 * which leaves a strip under the tab bar. The installed app always fills the
 * whole screen, so there the screen's own height is used. In a Safari tab
 * the browser bars come and go, so the visible height is used.
 */
function syncAppHeight(): void {
  let h = window.innerHeight;
  if (isIos() && isStandalone()) {
    const portrait = window.matchMedia('(orientation: portrait)').matches;
    const screenH = portrait ? Math.max(screen.width, screen.height) : Math.min(screen.width, screen.height);
    h = Math.max(h, screenH);
  }
  document.documentElement.style.setProperty('--app-h', `${h}px`);
}
syncAppHeight();
window.addEventListener('resize', syncAppHeight);
window.addEventListener('orientationchange', () => setTimeout(syncAppHeight, 300));

const container = document.getElementById('root');
if (!container) throw new Error('No #root element to mount into.');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

void registerServiceWorker();
