import { useEffect, useState } from 'react';

/** How long the screen takes to fade once loading is done. Matches the CSS. */
const FADE_MS = 350;

/**
 * The Farmranger logo inside a turning ring, over the whole app. Shown while
 * the session is checked and while an organisation's data first loads, so the
 * map and the count never appear empty ("0/0", zoomed out over the country)
 * before the data arrives. It fades out rather than vanishing, which also
 * gives the map that moment to frame the tags underneath it.
 */
export function LoadingScreen({ active, label }: { active: boolean; label?: string | undefined }): JSX.Element | null {
  const [mounted, setMounted] = useState(active);

  useEffect(() => {
    if (active) {
      setMounted(true);
      return;
    }
    const t = setTimeout(() => setMounted(false), FADE_MS);
    return () => clearTimeout(t);
  }, [active]);

  if (!mounted) return null;

  return (
    <div className={`loading-screen ${active ? '' : 'leaving'}`} role="status" aria-live="polite">
      <div className="loading-mark">
        <svg className="loading-ring" viewBox="0 0 120 120" aria-hidden="true">
          <circle className="loading-ring-track" cx="60" cy="60" r="54" />
          <circle className="loading-ring-arc" cx="60" cy="60" r="54" />
        </svg>
        <img className="loading-logo" src="/m/farmranger-logo.svg" alt="" width="84" height="84" />
      </div>
      <p className="loading-label">{label ?? 'Loading…'}</p>
    </div>
  );
}
