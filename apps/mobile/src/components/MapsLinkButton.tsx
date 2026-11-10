import { useEffect, useState } from 'react';

export function googleMapsUrl(lat: number, lon: number): string {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;
}

/** Clipboard API where allowed, a hidden textarea where it isn't (plain http, older browsers). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}

/**
 * "Open in maps", in two steps: the first press asks whether to open Google
 * Maps or copy the link. With no position (`lat`/`lon` null) the press shows
 * `noFixMessage` instead, so a missing fix is said out loud rather than the
 * button just being absent.
 */
export function MapsLinkButton({
  lat,
  lon,
  label = 'Open in Maps',
  noFixMessage = 'There is no GPS fix for this tag.',
  className = 'secondary as-button',
}: {
  lat: number | null;
  lon: number | null;
  label?: string;
  noFixMessage?: string;
  className?: string;
}): JSX.Element {
  const [step, setStep] = useState<'idle' | 'choose' | 'no-fix'>('idle');
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null);
  const hasFix = lat !== null && lon !== null;

  // Back to the single button whenever the position changes underneath it.
  useEffect(() => {
    setStep('idle');
    setCopied(null);
  }, [lat, lon]);

  if (step === 'no-fix') {
    return (
      <div className="maps-no-fix" role="alert">
        <span>{noFixMessage}</span>
        <button type="button" className="maps-x" aria-label="Close" onClick={() => setStep('idle')}>
          ×
        </button>
      </div>
    );
  }

  if (step === 'choose' && hasFix) {
    const url = googleMapsUrl(lat, lon);
    return (
      <div className="maps-choice">
        <a className={className} href={url} target="_blank" rel="noopener noreferrer" onClick={() => setStep('idle')}>
          Open
        </a>
        <button
          type="button"
          className={className}
          onClick={() => {
            void copyText(url).then((ok) => setCopied(ok ? 'yes' : 'failed'));
          }}
        >
          {copied === 'yes' ? 'Copied ✓' : copied === 'failed' ? 'Copy failed' : 'Copy link'}
        </button>
        <button type="button" className="maps-x" aria-label="Cancel" onClick={() => setStep('idle')}>
          ×
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        setCopied(null);
        setStep(hasFix ? 'choose' : 'no-fix');
      }}
    >
      {label}
    </button>
  );
}
