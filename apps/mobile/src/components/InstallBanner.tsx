import { useState } from 'react';
import { isIos, isStandalone } from '../push.js';
import { ShareIcon } from './SettingsSheet.js';

const DISMISS_KEY = 'tx-m-install-dismissed';

/**
 * iPhones have no install prompt, so in a Safari tab the app says how to add
 * itself to the Home Screen. That's also the only way to get notifications on
 * iOS. Hidden once installed, and for a week after it's dismissed.
 */
export function InstallBanner(): JSX.Element | null {
  const [hidden, setHidden] = useState(() => {
    try {
      const at = Number(localStorage.getItem(DISMISS_KEY) ?? 0);
      return Date.now() - at < 7 * 86_400_000;
    } catch {
      return false;
    }
  });

  if (hidden || isStandalone() || !isIos()) return null;

  return (
    <div className="install-banner">
      <p>
        Install the app: tap <ShareIcon /> then <strong>Add to Home Screen</strong>. Alerts can only be sent to the installed app.
      </p>
      <button
        aria-label="Dismiss"
        onClick={() => {
          try {
            localStorage.setItem(DISMISS_KEY, String(Date.now()));
          } catch {
            // Not remembered; it just shows again next time.
          }
          setHidden(true);
        }}
      >
        ✕
      </button>
    </div>
  );
}
