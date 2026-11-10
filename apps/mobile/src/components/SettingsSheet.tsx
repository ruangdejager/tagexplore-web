import { useCallback, useEffect, useState } from 'react';
import type { AuthUser } from '@tagexplore/core';
import * as api from '../api.js';
import { disablePush, enablePush, pushSupport, readPushState, type PushState } from '../push.js';
import type { GeofenceMode } from './MapTab.js';
import { Sheet } from './Sheet.js';

export function SettingsSheet(props: {
  user: AuthUser;
  orgs: Array<{ id: string; name: string }>;
  orgId: string | null;
  showFunctions: boolean;
  onShowFunctionsChange: (v: boolean) => void;
  /** Map functions are for `dev` and `admin` accounts; nobody else sees the switch. */
  canUseFunctions: boolean;
  showGeofences: boolean;
  onShowGeofencesChange: (v: boolean) => void;
  geofenceMode: GeofenceMode;
  onGeofenceModeChange: (v: GeofenceMode) => void;
  onClose: () => void;
  onLogout: () => void;
}): JSX.Element {
  return (
    <Sheet onClose={props.onClose} label="Settings">
      <div className="sheet-head">
        <div>
          <div className="sheet-title plain">Settings</div>
          <div className="sheet-sub">Signed in as {props.user.username}</div>
        </div>
      </div>

      <section className="settings-section">
        <h2>Map</h2>
        <SettingToggle
          label="Geofences"
          note="The organisation's boundaries on the map"
          checked={props.showGeofences}
          onChange={props.onShowGeofencesChange}
        />
        {props.showGeofences && (
          <div className="geofence-mode">
            <div className="segmented" role="radiogroup" aria-label="Which geofences">
              {(['smart', 'all'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={props.geofenceMode === mode}
                  data-on={props.geofenceMode === mode ? '1' : '0'}
                  onClick={() => props.onGeofenceModeChange(mode)}
                >
                  {mode === 'smart' ? 'Smart' : 'All'}
                </button>
              ))}
            </div>
            <small>
              {props.geofenceMode === 'smart' ? 'Only geofences with tags in them' : 'Every geofence of the organisation'}
            </small>
          </div>
        )}
        {props.canUseFunctions && (
          <button
            type="button"
            role="switch"
            aria-checked={props.showFunctions}
            className="setting-toggle"
            onClick={() => props.onShowFunctionsChange(!props.showFunctions)}
          >
            <span className="fn-text">
              <span>Map functions</span>
              <small>Link view or a 7-day heatmap, under the count on the map</small>
            </span>
            <span className="switch-track" data-on={props.showFunctions ? '1' : '0'}>
              <span />
            </span>
          </button>
        )}
      </section>

      <NotificationSettings orgId={props.orgId} orgs={props.orgs} />

      <section className="settings-section">
        <a className="link-row" href="/">
          Open the full desktop site
        </a>
        <button className="secondary danger" onClick={props.onLogout}>
          Sign out
        </button>
      </section>
    </Sheet>
  );
}

function NotificationSettings({ orgId, orgs }: { orgId: string | null; orgs: Array<{ id: string; name: string }> }): JSX.Element {
  const support = pushSupport();
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; bad?: boolean } | null>(null);

  useEffect(() => {
    if (support === 'supported') readPushState().then(setState).catch(() => setState(null));
  }, [support]);

  const run = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : 'Something went wrong.', bad: true });
    } finally {
      setBusy(false);
    }
  }, []);

  const orgName = (id: string | null): string => orgs.find((o) => o.id === id)?.name ?? 'another organisation';

  let body: JSX.Element;
  if (support === 'insecure') {
    body = <p className="hint">Notifications need the app to be opened over https.</p>;
  } else if (support === 'needs-install') {
    body = (
      <p className="hint">
        To get alerts on this iPhone, add Farmranger Tags to your Home Screen first: tap <ShareIcon /> <strong>Share</strong>,
        then <strong>Add to Home Screen</strong>, and open it from the new icon.
      </p>
    );
  } else if (support === 'unsupported') {
    body = <p className="hint">This browser can’t receive notifications. On iPhone this needs iOS 16.4 or later.</p>;
  } else if (!state) {
    body = <p className="hint">Checking…</p>;
  } else if (state.subscribed && state.orgId === orgId) {
    body = (
      <>
        <p className="status-line good">On for {orgName(orgId)}. You’ll get a notification when a tag goes still or stops reporting.</p>
        <div className="button-row">
          <button
            className="secondary"
            disabled={busy}
            onClick={() =>
              run(async () => {
                await api.pushTest(state.endpoint!);
                setMessage({ text: 'Test sent. It should arrive in a few seconds.' });
              })
            }
          >
            Send a test
          </button>
          <button
            className="secondary"
            disabled={busy}
            onClick={() =>
              run(async () => {
                await disablePush();
                setState(await readPushState());
              })
            }
          >
            Turn off
          </button>
        </div>
      </>
    );
  } else {
    const switching = state.subscribed && state.orgId !== orgId;
    body = (
      <>
        {switching && <p className="hint">Currently on for {orgName(state.orgId)}.</p>}
        {state.permission === 'denied' ? (
          <p className="hint bad">
            Notifications are blocked for this app. Allow them in your phone’s Settings › Notifications › Farmranger Tags, then come back here.
          </p>
        ) : (
          <button
            className="primary"
            disabled={busy || !orgId}
            onClick={() =>
              run(async () => {
                setState(await enablePush(orgId!));
                setMessage({ text: 'Notifications are on.' });
              })
            }
          >
            {switching ? `Follow ${orgName(orgId)} instead` : 'Turn on notifications'}
          </button>
        )}
      </>
    );
  }

  return (
    <section className="settings-section">
      <h2>Alert notifications</h2>
      {body}
      {message && <p className={`hint ${message.bad ? 'bad' : 'good'}`}>{message.text}</p>}
    </section>
  );
}

function SettingToggle(props: { label: string; note: string; checked: boolean; onChange: (v: boolean) => void }): JSX.Element {
  return (
    <button type="button" role="switch" aria-checked={props.checked} className="setting-toggle" onClick={() => props.onChange(!props.checked)}>
      <span className="fn-text">
        <span>{props.label}</span>
        <small>{props.note}</small>
      </span>
      <span className="switch-track" data-on={props.checked ? '1' : '0'}>
        <span />
      </span>
    </button>
  );
}

export function ShareIcon(): JSX.Element {
  return (
    <svg className="inline-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path d="M12 3v12M7.5 7.5 12 3l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8 10.5H6v10h12v-10h-2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  );
}
