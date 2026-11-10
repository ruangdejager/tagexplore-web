import { useEffect, useState } from 'react';

/** Past this, loading has stalled (a slow server, a dropped request) and a Reload button is offered. */
const SLOW_MS = 15_000;

/**
 * The Farmranger logo in a turning ring, shown while the session is checked
 * and the first organisation's data loads — instead of a bare dark page, which
 * is indistinguishable from a broken one. If it is still up after
 * `SLOW_MS` it says so and offers a reload.
 */
export function LoadingScreen({ label }: { label?: string }): JSX.Element {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), SLOW_MS);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className="loading-screen" role="status" aria-live="polite">
      <div className="loading-mark">
        <svg className="loading-ring" viewBox="0 0 120 120" aria-hidden="true">
          <circle className="loading-ring-track" cx="60" cy="60" r="54" />
          <circle className="loading-ring-arc" cx="60" cy="60" r="54" />
        </svg>
        <img className="loading-logo" src="/farmranger-logo.svg" alt="" width="84" height="84" />
      </div>
      <p className="loading-label">{label ?? 'Loading…'}</p>
      {slow && (
        <div className="loading-slow">
          <p>This is taking longer than it should.</p>
          <button type="button" className="pill" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      )}
    </div>
  );
}
