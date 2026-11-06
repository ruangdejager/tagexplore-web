import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AuthUser, TagSnapshot } from '@tagexplore/core';
import * as api from './api.js';
import { AlertsView } from './components/AlertsView.js';
import { InstallBanner } from './components/InstallBanner.js';
import { LoginScreen } from './components/LoginScreen.js';
import { MapTab } from './components/MapTab.js';
import { OrgPicker } from './components/OrgPicker.js';
import { SettingsSheet } from './components/SettingsSheet.js';
import { TagSheet } from './components/TagSheet.js';
import { TagsView } from './components/TagsView.js';
import { usePref } from './prefs.js';
import { setBadge } from './push.js';
import { useOrgData } from './useOrgData.js';

type Tab = 'map' | 'tags' | 'alerts';
const ORG_KEY = 'tx-m-org';

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode or storage blocked: the choice just isn't remembered.
  }
}

/** `?org=…&tag=…`, which is what a tapped notification opens. */
function readLink(href: string): { org: string | null; tag: string | null } {
  const url = new URL(href, window.location.origin);
  return { org: url.searchParams.get('org'), tag: url.searchParams.get('tag') };
}

export function App(): JSX.Element {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [orgs, setOrgs] = useState<Array<{ id: string; name: string }>>([]);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('map');
  /** The tag whose card is open; `snap` is a past round's reading, `fromMap` hides "Show on map". */
  const [openTag, setOpenTagState] = useState<{ tagId: string; snap?: TagSnapshot; fromMap?: boolean } | null>(null);
  const setOpenTag = useCallback((tagId: string | null) => setOpenTagState(tagId ? { tagId } : null), []);
  const [mapFocus, setMapFocus] = useState<{ tagId: string; n: number } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Off until switched on in settings.
  const [showFunctions, setShowFunctions] = usePref('tx-m-show-functions', false);
  const [pendingLink, setPendingLink] = useState(() => readLink(window.location.href));

  useEffect(() => {
    api
      .fetchMe()
      .then((res) => setUser(res.user))
      .catch(() => setUser(null))
      .finally(() => setAuthChecked(true));
  }, []);

  useEffect(() => {
    if (!user) return;
    api
      .fetchOrgs(user)
      .then((list) => {
        setOrgs(list);
        const wanted = pendingLink.org ?? readStored(ORG_KEY);
        setOrgId(list.find((o) => o.id === wanted)?.id ?? list[0]?.id ?? null);
      })
      .catch(() => setOrgs([]));
    // Only on login; a link arriving later is handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // A notification tapped while the app is already open arrives as a message
  // from the service worker rather than as a page load.
  useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      const data = e.data as { type?: string; url?: string };
      if (data?.type === 'open' && data.url) setPendingLink(readLink(data.url));
    };
    navigator.serviceWorker?.addEventListener('message', onMessage);
    return () => navigator.serviceWorker?.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    if (!orgs.length) return;
    if (pendingLink.org && orgs.some((o) => o.id === pendingLink.org)) setOrgId(pendingLink.org);
    if (pendingLink.tag) {
      setTab('alerts');
      setOpenTag(pendingLink.tag);
    }
    if (pendingLink.org || pendingLink.tag) {
      // Clear it from the address bar so a reload doesn't reopen the same tag.
      window.history.replaceState(null, '', '/m/');
      setPendingLink({ org: null, tag: null });
    }
  }, [pendingLink, orgs]);

  useEffect(() => {
    if (orgId) writeStored(ORG_KEY, orgId);
  }, [orgId]);

  const data = useOrgData(user ? orgId : null);
  useEffect(() => setBadge(data.alerts.length), [data.alerts.length]);

  const openRow = useMemo(() => data.rows.find((r) => r.tagId === openTag?.tagId) ?? null, [data.rows, openTag]);

  const showOnMap = useCallback((tagId: string) => {
    setOpenTagState(null);
    setTab('map');
    setMapFocus((f) => ({ tagId, n: (f?.n ?? 0) + 1 }));
  }, []);

  const logout = useCallback(async () => {
    await api.logout().catch(() => undefined);
    setSettingsOpen(false);
    setUser(null);
    setOrgs([]);
    setOrgId(null);
  }, []);

  if (!authChecked) return <div className="splash" />;
  if (!user) return <LoginScreen onLoggedIn={setUser} />;

  return (
    <div className="shell">
      <header className="topbar">
        <OrgPicker orgs={orgs} orgId={orgId} onPick={setOrgId} />
        <span className={`live-dot ${data.live ? 'on' : ''}`} role="img" aria-label={data.live ? 'Live' : 'Not live'} />
        <button className="icon-button" onClick={() => setSettingsOpen(true)} aria-label="Settings">
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <circle cx="12" cy="8" r="3.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
            <path d="M5 20c1.2-3.6 4-5.2 7-5.2s5.8 1.6 7 5.2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
      </header>

      <InstallBanner />

      <main className="content">
        {!orgId && <p className="empty">Your account is not in an organisation yet. An admin needs to add you to one.</p>}
        {/* The map stays mounted behind the other tabs, so coming back to it
            (or "Show on map") never rebuilds it. */}
        {orgId && (
          <div className={`pane pane-map ${tab === 'map' ? '' : 'pane-hidden'}`} aria-hidden={tab !== 'map'}>
            <MapTab
              orgId={orgId}
              data={data}
              visible={tab === 'map'}
              focus={mapFocus}
              onOpenTag={(tagId, snap) => setOpenTagState({ tagId, ...(snap ? { snap } : {}), fromMap: true })}
              showFunctions={showFunctions}
            />
          </div>
        )}
        {orgId && tab !== 'map' && (
          <div className="pane pane-list">
            {tab === 'alerts' && <AlertsView data={data} onOpenTag={setOpenTag} />}
            {tab === 'tags' && <TagsView data={data} onOpenTag={setOpenTag} />}
          </div>
        )}
      </main>

      <nav className="tabbar" aria-label="Sections">
        <TabButton id="map" current={tab} onSelect={setTab} label="Map">
          <path d="M9 4 3.5 6v14L9 18l6 2 5.5-2V4L15 6 9 4Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
          <path d="M9 4v14M15 6v14" stroke="currentColor" strokeWidth="1.8" />
        </TabButton>
        <TabButton id="tags" current={tab} onSelect={setTab} label="Tags">
          <path d="M5 6.5h14M5 12h14M5 17.5h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </TabButton>
        <TabButton id="alerts" current={tab} onSelect={setTab} label="Alerts" badge={data.alerts.length}>
          <path d="M12 3.5 2.8 19.5h18.4L12 3.5Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
          <path d="M12 10v4.2M12 16.6v.4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </TabButton>
      </nav>

      {openTag && (
        <TagSheet
          tagId={openTag.tagId}
          row={openRow}
          snap={openTag.snap}
          devices={data.devices}
          onClose={() => setOpenTagState(null)}
          onShowOnMap={openTag.fromMap ? undefined : showOnMap}
        />
      )}
      {settingsOpen && (
        <SettingsSheet
          user={user}
          orgs={orgs}
          orgId={orgId}
          showFunctions={showFunctions}
          onShowFunctionsChange={setShowFunctions}
          onClose={() => setSettingsOpen(false)}
          onLogout={logout}
        />
      )}
    </div>
  );
}

function TabButton(props: {
  id: Tab;
  current: Tab;
  label: string;
  badge?: number;
  onSelect: (t: Tab) => void;
  children: React.ReactNode;
}): JSX.Element {
  const active = props.id === props.current;
  return (
    <button className={`tab ${active ? 'active' : ''}`} onClick={() => props.onSelect(props.id)} aria-current={active ? 'page' : undefined}>
      <span className="tab-icon">
        <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
          {props.children}
        </svg>
        {props.badge ? <span className="tab-badge">{props.badge > 99 ? '99+' : props.badge}</span> : null}
      </span>
      <span className="tab-label">{props.label}</span>
    </button>
  );
}
