import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';

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
