import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type DeviceRow,
  type DiscoveryWindow,
  type GeofenceRegion,
  type OrgTagRow,
  type OrganisationRow,
  type TagSnapshot,
} from '@tagexplore/core';
import * as api from './api.js';
import { AdminPanel } from './components/AdminPanel.js';
import { AlertsPanel } from './components/AlertsPanel.js';
import { BatteryTrends } from './components/BatteryTrends.js';
import { CountPanel } from './components/CountPanel.js';
import { DeviceCard } from './components/DeviceCard.js';
import { DeviceList } from './components/DeviceList.js';
import { LoginScreen } from './components/LoginScreen.js';
import { MapLegend } from './components/MapLegend.js';
import { MapView, type MarkerColorMode } from './components/MapView.js';
import { OrgRequestPanel } from './components/OrgRequestPanel.js';
import { TagCard } from './components/TagCard.js';
import { TagList } from './components/TagList.js';
import { ViewPanel, type MainView } from './components/ViewPanel.js';
import { useAuth } from './state/useAuth.js';
import { useHeatPoints } from './state/useHeatPoints.js';
import { useSnapshots } from './state/useSnapshots.js';

/**
 * Tags themselves are never time-filtered — the list and map always show
 * every whitelisted tag's latest known state, however old. This is simply a
 * generous ceiling on how far back that "latest" lookup reaches (the server
 * caps a window at 365 days regardless), so a tag that hasn't reported in
 * months doesn't vanish rather than show as "over 3 days".
 */
const SNAPSHOT_WINDOW_HOURS = 24 * 365;

/** Windows the heatmap can be asked to summarise. */
const HEATMAP_WINDOWS: Array<{ hours: number; label: string }> = [
  { hours: 6, label: 'Last 6 hours' },
  { hours: 24, label: 'Last 24 hours' },
  { hours: 72, label: 'Last 3 days' },
  { hours: 168, label: 'Last 7 days' },
  { hours: 720, label: 'Last 30 days' },
];

/**
 * Splits on auth state rather than branching inside one component: the authed
 * app below calls hooks (data fetches, timers) that only make sense once a
 * session exists, and conditionally calling those hooks would break the Rules
 * of Hooks. Rendering an entirely different component sidesteps that.
 */
export function App(): JSX.Element | null {
  const auth = useAuth();

  // Nothing renders while the session cookie is still being checked — a
  // refresh that turns out to be authed should never flash the login form
  // first, and one that turns out anonymous loses nothing by waiting the
  // one request it takes to find out.
  if (auth.status === 'checking') return null;
  if (auth.status !== 'authed') {
    return <LoginScreen auth={auth} />;
  }
  return <AuthedApp auth={auth} />;
}

function AuthedApp({ auth }: { auth: ReturnType<typeof useAuth> }): JSX.Element | null {
  const [showAdmin, setShowAdmin] = useState(false);

  const [orgs, setOrgs] = useState<OrganisationRow[]>([]);
  // Whether the organisation list itself has been fetched — only meaningful
  // for an admin; a plain user's orgs come from `auth.user` with no fetch.
  const [orgsLoaded, setOrgsLoaded] = useState(false);
  // The org id the whitelist currently in state actually belongs to, mirroring
  // `useSnapshots`'s own `loadedOrgId` — lets a genuine org change be told
  // apart from a background refetch of the same one.
  const [loadedWhitelistOrgId, setLoadedWhitelistOrgId] = useState<string | null>(null);
  const [viewOrgId, setViewOrgId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [hiddenFromMap, setHiddenFromMap] = useState<Set<string>>(new Set());
  // Devices switched off in the main list — excluded from every reading
  // everywhere (map, tag list, counts, history), not just hidden from the
  // map the way a tag toggle is. Persisted the same way `hiddenFromMap` is.
  const [hiddenDeviceImeis, setHiddenDeviceImeis] = useState<Set<string>>(new Set());
  const [selectedDeviceImei, setSelectedDeviceImei] = useState<string | null>(null);
  const [heatmapView, setHeatmapView] = useState(false);
  const [linkView, setLinkView] = useState(false);
  // Unlike heatmap/link, this one is remembered across sessions — see the
  // preferences load/save effects below.
  const [geofencesView, setGeofencesView] = useState(false);
  const [geofences, setGeofences] = useState<GeofenceRegion[]>([]);
  // True while "Refresh" is out live-pulling every device — not the same as
  // `loading` below, which just reflects the follow-up DB re-read.
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [heatmapHours, setHeatmapHours] = useState(72);
  const [colorMode, setColorMode] = useState<MarkerColorMode>('discovery');
  const [discoveryWindow, setDiscoveryWindow] = useState<DiscoveryWindow>('6');
  const [mainView, setMainView] = useState<MainView>('global');
  const [selectedTagId, setSelectedTagId] = useState<string | null>(null);
  const [fitNonce, setFitNonce] = useState(0);
  // Which past discovery round (the count history's `bracketAt`) the map is
  // showing instead of the live state — null means live. Owned here, not
  // inside CountPanel, because it has to reach the map.
  const [historyAt, setHistoryAt] = useState<number | null>(null);
  const [historySnapshots, setHistorySnapshots] = useState<TagSnapshot[] | null>(null);
  const [historyDevices, setHistoryDevices] = useState<DeviceRow[] | null>(null);
  const [trendTags, setTrendTags] = useState<Set<string>>(new Set());
  // Tucked out of the way by default — the map is the main event, and this is
  // a drawer for when battery history is actually wanted. Owned here (not
  // inside BatteryTrends) so a tag card's "Battery trend" button can expand
  // it, not just pick which tag it shows.
  const [trendExpanded, setTrendExpanded] = useState(false);
  const [whitelist, setWhitelist] = useState<OrgTagRow[]>([]);
  const [now, setNow] = useState(() => Date.now());
  // Guards the save effect below from firing with the fresh-state defaults
  // before the saved preferences have actually come back from the server.
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  // The org this user was last looking at, from the server — applied to
  // viewOrgId once it's actually one of the org's they can still see.
  const [savedOrgId, setSavedOrgId] = useState<string | null>(null);

  const isAdmin = auth.user?.role === 'admin';
  // A user can belong to several organisations; the dropdown only ever offers
  // the ones they're actually assigned to. An admin's dropdown offers every
  // organisation instead, regardless of their own (usually empty) membership
  // list — the server enforces both sides of this regardless of what is sent.
  const myOrgs = auth.user?.orgs ?? [];
  const availableOrgs = isAdmin ? orgs : myOrgs;
  const orgId = viewOrgId ?? availableOrgs[0]?.id ?? null;
  const canSeeData = orgId !== null;

  // Undefined (not an empty array) when nothing is excluded — the server's
  // own convention for "no filter, every device kept", and cheaper than
  // sending every device's id back on the common case of none switched off.
  const excludeDeviceImeis = useMemo(
    () => (hiddenDeviceImeis.size > 0 ? [...hiddenDeviceImeis] : undefined),
    [hiddenDeviceImeis],
  );

  // Tags are never time-filtered — every whitelisted tag always shows its
  // latest known state, so the fetch window here is just a generous ceiling,
  // not a user-facing setting. The heatmap gets its own window below.
  const { snapshots, devices, loading, hasLoaded, error, refresh } = useSnapshots(
    orgId,
    SNAPSHOT_WINDOW_HOURS,
    canSeeData,
    excludeDeviceImeis,
  );
  const heatPoints = useHeatPoints(orgId, heatmapHours, heatmapView);

  // "3h ago" has to keep counting without a refetch, so the clock the list and
  // card format against ticks on its own.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  // A different organisation invalidates whatever past round was showing —
  // its history belongs to the org that was picked when it loaded.
  useEffect(() => {
    setHistoryAt(null);
  }, [orgId]);

  // Fetches the whitelist's state as of the picked round — same shape as the
  // live snapshots, so the map can show it through the very same prop.
  useEffect(() => {
    if (historyAt === null || !orgId) {
      setHistorySnapshots(null);
      return;
    }
    let cancelled = false;
    api
      .fetchSnapshotsAt(orgId, historyAt, excludeDeviceImeis)
      .then((res) => {
        if (!cancelled) setHistorySnapshots(res.snapshots);
      })
      .catch(() => {
        if (!cancelled) setHistorySnapshots([]);
      });
    return () => {
      cancelled = true;
    };
  }, [historyAt, orgId, excludeDeviceImeis]);

  // Same idea for the readers themselves — the purple marker for a past round
  // belongs at wherever that reader actually was then, not its live position.
  useEffect(() => {
    if (historyAt === null || !orgId) {
      setHistoryDevices(null);
      return;
    }
    let cancelled = false;
    api
      .fetchDevicesAt(orgId, historyAt)
      .then((res) => {
        if (!cancelled) setHistoryDevices(res.devices);
      })
      .catch(() => {
        if (!cancelled) setHistoryDevices([]);
      });
    return () => {
      cancelled = true;
    };
  }, [historyAt, orgId]);

  useEffect(() => {
    if (!isAdmin) {
      setOrgsLoaded(true);
      return;
    }
    api
      .fetchOrgs()
      .then((res) => setOrgs(res.orgs))
      .catch(() => setOrgs([]))
      .finally(() => setOrgsLoaded(true));
  }, [isAdmin, showAdmin]);

  useEffect(() => {
    if (!canSeeData) return;
    api
      .fetchOrgTags(orgId)
      .then((res) => setWhitelist(res.tags))
      .catch(() => setWhitelist([]))
      .finally(() => setLoadedWhitelistOrgId(orgId));
  }, [canSeeData, orgId]);

  // Loads once per organisation, and again whenever "Refresh" pulls fresh
  // ones in from the platform — pulled out to a function rather than left
  // inline in the effect so the refresh handler further down can call it too.
  const loadGeofences = useCallback((): void => {
    if (!canSeeData) {
      setGeofences([]);
      return;
    }
    api.fetchGeofences(orgId).then((res) => setGeofences(res.geofences)).catch(() => setGeofences([]));
  }, [canSeeData, orgId]);

  useEffect(loadGeofences, [loadGeofences]);

  // The main tag-list toggle, the marker-colour legend, and the last org
  // looked at are this user's own preferences, not this session's — loaded
  // once on login so they carry over from wherever they were last left,
  // saved back on every change.
  useEffect(() => {
    let cancelled = false;
    api
      .fetchPreferences()
      .then((res) => {
        if (cancelled) return;
        setHiddenFromMap(new Set(res.preferences.hiddenTagIds));
        setColorMode(res.preferences.colorMode);
        setSavedOrgId(res.preferences.lastOrgId);
        setGeofencesView(res.preferences.geofencesView);
        setHiddenDeviceImeis(new Set(res.preferences.hiddenDeviceImeis));
      })
      .finally(() => {
        if (!cancelled) setPrefsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Applied once, and only once it's actually one of the orgs this user can
  // currently see — a stale saved org (deleted, or access since revoked)
  // just falls through to the ordinary "first available" default instead.
  useEffect(() => {
    if (!prefsLoaded || savedOrgId === null || viewOrgId !== null) return;
    if (availableOrgs.some((org) => org.id === savedOrgId)) setViewOrgId(savedOrgId);
  }, [prefsLoaded, savedOrgId, availableOrgs, viewOrgId]);

  // True once `orgId` has settled on its final value — the effect above will
  // never again change it, either because there was no saved org to restore,
  // it's already been applied, or it doesn't match anything this user can
  // see. Gating on this (not just `prefsLoaded`) is what stops the app
  // rendering the first-available org for a moment before jumping to the
  // actually-remembered one.
  const orgSelectionResolved =
    prefsLoaded &&
    orgsLoaded &&
    (savedOrgId === null || viewOrgId !== null || !availableOrgs.some((org) => org.id === savedOrgId));

  // Nothing is shown until every piece the first paint depends on — the
  // resolved org, its whitelist, and its snapshots — has actually arrived, so
  // there is never a moment showing the wrong org or an empty, unfitted map.
  const dataReady =
    orgSelectionResolved && (!canSeeData || (loadedWhitelistOrgId === orgId && hasLoaded));

  useEffect(() => {
    if (!prefsLoaded) return;
    void api
      .savePreferences({
        hiddenTagIds: [...hiddenFromMap],
        colorMode,
        lastOrgId: orgId,
        geofencesView,
        hiddenDeviceImeis: [...hiddenDeviceImeis],
      })
      .catch(() => {});
  }, [prefsLoaded, hiddenFromMap, colorMode, orgId, geofencesView, hiddenDeviceImeis]);

  // Every tag starts toggled on in the battery trend, once per organisation —
  // not on every whitelist refetch, so a deliberate "None" or a manual toggle
  // isn't quietly overwritten a minute later.
  const trendTagsInitFor = useRef<string | null>(null);
  useEffect(() => {
    if (whitelist.length === 0 || trendTagsInitFor.current === orgId) return;
    trendTagsInitFor.current = orgId;
    setTrendTags(new Set(whitelist.map((t) => t.tagId)));
  }, [whitelist, orgId]);

  /** The sidebar list: every tag, search-filtered only — never by age — newest seen first. */
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = needle
      ? snapshots.filter(
          (tag: TagSnapshot) =>
            tag.tagId.toLowerCase().includes(needle) || (tag.label ?? '').toLowerCase().includes(needle),
        )
      : snapshots;
    return [...filtered].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }, [snapshots, query]);

  // What the map actually plots: the live state, unless a past discovery
  // round is picked, in which case it's that round's snapshot instead — same
  // shape, same search/hide filters, just a different source array. This is
  // the only thing that changes when browsing history; the map's own pan and
  // zoom are never touched by it (see MapView's markers effect).
  const mapSourceSnapshots = historyAt !== null && historySnapshots !== null ? historySnapshots : snapshots;
  const mapSourceDevices = historyAt !== null && historyDevices !== null ? historyDevices : devices;
  const mapVisible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle
      ? mapSourceSnapshots.filter(
          (tag: TagSnapshot) =>
            tag.tagId.toLowerCase().includes(needle) || (tag.label ?? '').toLowerCase().includes(needle),
        )
      : mapSourceSnapshots;
  }, [mapSourceSnapshots, query]);
  /** The map's markers: the same list, minus whatever the per-tag toggle hid. */
  const mapTags = useMemo(() => mapVisible.filter((tag) => !hiddenFromMap.has(tag.tagId)), [mapVisible, hiddenFromMap]);

  // The same per-tag list toggle also decides what counts as "toggled on" for
  // the unique-tag count and the alerts panel — a tag switched off is left out
  // of both, the same way it's left off the map.
  const toggledSnapshots = useMemo(() => snapshots.filter((s) => !hiddenFromMap.has(s.tagId)), [snapshots, hiddenFromMap]);
  const watchedTagIds = useMemo(() => new Set(toggledSnapshots.map((s) => s.tagId)), [toggledSnapshots]);
  // Always the live latest round's time, regardless of what's being browsed —
  // what the LIVE badge shows as the thing it would jump back to.
  const latestDiscoveryAt = useMemo(
    () => (toggledSnapshots.length > 0 ? Math.max(...toggledSnapshots.map((s) => s.lastSeenAt)) : null),
    [toggledSnapshots],
  );

  // What the count panel's own fraction counts against — whatever the map is
  // actually showing, live or a past round; the discovery-state legend no
  // longer shares this with the fraction (it colours strictly by the round
  // being shown, not by the fraction's own selectable window — see MapView).
  const mapToggledSnapshots = useMemo(
    () => mapSourceSnapshots.filter((s) => !hiddenFromMap.has(s.tagId)),
    [mapSourceSnapshots, hiddenFromMap],
  );
  // What "Recentre" frames to on either map: every org tag's own position,
  // regardless of the list's toggles or search — unlike the global map's
  // "fit to shown", this is a fixed reference point, not a filtered one.
  const orgPoints = useMemo(
    () => snapshots.filter((s) => s.lat !== null && s.lon !== null).map((s) => [s.lat as number, s.lon as number] as [number, number]),
    [snapshots],
  );

  const selected = visible.find((t) => t.tagId === selectedTagId) ?? null;
  const selectedDevice = devices.find((d) => d.imei === selectedDeviceImei) ?? null;

  const toggleMapVisibility = useCallback((tagId: string): void => {
    setHiddenFromMap((prev) => {
      const next = new Set(prev);
      if (next.has(tagId)) next.delete(tagId);
      else next.add(tagId);
      return next;
    });
  }, []);

  const toggleDevice = useCallback((imei: string): void => {
    setHiddenDeviceImeis((prev) => {
      const next = new Set(prev);
      if (next.has(imei)) next.delete(imei);
      else next.add(imei);
      return next;
    });
  }, []);

  // A tag and a device card never show at once — selecting one clears the other.
  const selectTag = useCallback((tagId: string | null): void => {
    setSelectedTagId(tagId);
    setSelectedDeviceImei(null);
  }, []);

  const selectDevice = useCallback((imei: string): void => {
    setSelectedDeviceImei(imei);
    setSelectedTagId(null);
  }, []);

  const selectHistory = useCallback((bracketAt: number): void => {
    setHistoryAt(bracketAt);
  }, []);

  const goLive = useCallback((): void => {
    setHistoryAt(null);
  }, []);

  const toggleTrendTag = useCallback((tagId: string): void => {
    setTrendTags((prev) => {
      const next = new Set(prev);
      if (next.has(tagId)) next.delete(tagId);
      else next.add(tagId);
      return next;
    });
  }, []);

  // "Refresh" means a real, live pull — not just a re-read of whatever's
  // already in the database. It goes out to every one of this org's readers
  // for their schedule, their log, and (same call as the log) their own
  // position and geofences — the purple marker updates on this same click,
  // not on some separate cadence. The DB re-read happens regardless of
  // whether the live pull fully succeeded, so a partial failure still shows
  // whatever did come in rather than nothing at all.
  const handleRefresh = useCallback((): void => {
    if (!orgId || refreshingAll) return;
    setRefreshingAll(true);
    void api
      .refreshAll(orgId)
      .catch(() => {})
      .then(() => {
        refresh();
        loadGeofences();
      })
      .finally(() => setRefreshingAll(false));
  }, [orgId, refreshingAll, refresh, loadGeofences]);

  // Every hook above still runs on every render regardless — only the JSX
  // this returns is held back, so nothing half-loaded (the wrong org, an
  // empty unfitted map) is ever painted.
  if (!dataReady) return null;

  return (
    <div id="app">
      <header>
        <button className="mark" onClick={() => setFitNonce((n) => n + 1)} title="Fit the map to every tag shown">
          Tag<span>·</span>Explore
        </button>

        <div className="tally">
          <b>{whitelist.length}</b> tags · <b>{devices.length}</b> devices
          {loading && ' · loading…'}
          {error && <span className="status-error"> · {error}</span>}
        </div>

        <div className="header-right">
          {availableOrgs.length > 1 && (
            <select
              className="pill"
              value={orgId ?? ''}
              onChange={(e) => {
                setViewOrgId(e.target.value || null);
                setSelectedTagId(null);
                setSelectedDeviceImei(null);
                setTrendTags(new Set());
              }}
              title={isAdmin ? 'Look at another organisation' : 'Switch organisation'}
            >
              {availableOrgs.map((org) => (
                <option key={org.id} value={org.id}>
                  {org.name}
                </option>
              ))}
            </select>
          )}

          {isAdmin && (
            <button className="pill" onClick={() => setShowAdmin(true)}>
              Admin
            </button>
          )}
          <button className="pill" onClick={() => void auth.logout()}>
            {auth.user?.username} · log out
          </button>
        </div>
      </header>

      <aside>
        <ViewPanel view={mainView} onChange={setMainView} />
        <div className="aside-body">
          <div className="filters">
            <button
              className="pill"
              style={{ width: '100%' }}
              onClick={handleRefresh}
              disabled={refreshingAll}
              title="Pull each reader's schedule, log, position and geofences fresh, then reload"
            >
              {refreshingAll ? 'Refreshing…' : 'Refresh'}
            </button>

            <button
              className="pill"
              style={{ width: '100%' }}
              data-on={geofencesView ? '1' : '0'}
              onClick={() => setGeofencesView((v) => !v)}
              title="Geofence boundaries read off each reader's own events feed"
            >
              Enable Geofences
            </button>

            {mainView === 'global' && (
              <div className="filter-row-split">
                <button
                  className="pill"
                  data-on={heatmapView ? '1' : '0'}
                  disabled={linkView}
                  onClick={() => setHeatmapView((v) => !v)}
                  title={linkView ? 'Turn off Link view to use this' : undefined}
                >
                  Heatmap view
                </button>
                <button
                  className="pill"
                  data-on={linkView ? '1' : '0'}
                  disabled={heatmapView}
                  onClick={() => setLinkView((v) => !v)}
                  title={
                    heatmapView
                      ? 'Turn off Heatmap view to use this'
                      : 'Dotted lines from each tag in the latest discovery to the tag its data relayed through'
                  }
                >
                  Link view
                </button>
              </div>
            )}

            {mainView === 'global' && (
              <select
                value={heatmapHours}
                disabled={!heatmapView}
                onChange={(e) => setHeatmapHours(Number(e.target.value))}
                title={heatmapView ? 'Heatmap window' : 'Turn on Heatmap view to use this'}
              >
                {HEATMAP_WINDOWS.map((w) => (
                  <option key={w.hours} value={w.hours}>
                    {w.label}
                  </option>
                ))}
              </select>
            )}

            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="tag id or label"
              autoComplete="off"
            />
          </div>

          {!canSeeData && !isAdmin && <OrgRequestPanel />}
          <DeviceList
            devices={devices}
            selectedDeviceImei={selectedDeviceImei}
            onSelect={selectDevice}
            hiddenDeviceImeis={hiddenDeviceImeis}
            onToggle={toggleDevice}
          />
          <TagList
            snapshots={visible}
            selectedTagId={selectedTagId}
            onSelect={selectTag}
            now={now}
            hiddenFromMap={hiddenFromMap}
            onToggleMapVisibility={toggleMapVisibility}
          />
        </div>
      </aside>

      <MapView
        mode={mainView}
        snapshots={mapTags}
        selectedTagId={selectedTagId}
        onSelect={selectTag}
        fitNonce={fitNonce}
        autoFitKey={orgId}
        heatmapView={heatmapView}
        heatPoints={heatPoints}
        linkView={linkView}
        devices={mapSourceDevices}
        onSelectDevice={selectDevice}
        geofences={geofences}
        geofencesView={geofencesView}
        colorMode={colorMode}
        gpsWindow={discoveryWindow}
        historyAt={historyAt}
        orgId={orgId}
        movementSnapshots={toggledSnapshots}
        orgPoints={orgPoints}
      >
        <div className="map-topleft">
          <CountPanel
            snapshots={mapToggledSnapshots}
            now={historyAt ?? now}
            orgId={orgId}
            windowChoice={discoveryWindow}
            onWindowChange={setDiscoveryWindow}
            historyAt={historyAt}
            onSelectHistory={selectHistory}
            onGoLive={goLive}
            latestDiscoveryAt={latestDiscoveryAt}
            excludeDeviceImeis={excludeDeviceImeis}
          />
          <AlertsPanel
            watchedTagIds={watchedTagIds}
            snapshots={snapshots}
            tags={whitelist}
            now={now}
            onSelectTag={selectTag}
          />
          {selectedDevice && <DeviceCard device={selectedDevice} now={now} onClose={() => setSelectedDeviceImei(null)} />}
          {selected && (
            <TagCard
              tag={selected}
              devices={devices}
              now={now}
              onClose={() => setSelectedTagId(null)}
              onShowTrend={(tagId) => {
                setTrendTags(new Set([tagId]));
                setTrendExpanded(true);
              }}
            />
          )}
        </div>
        <MapLegend mode={colorMode} onChange={setColorMode} gpsWindow={discoveryWindow} />
      </MapView>

      <BatteryTrends
        orgId={orgId}
        tags={whitelist}
        selected={trendTags}
        onToggle={toggleTrendTag}
        onSelectOnly={(ids) => setTrendTags(new Set(ids))}
        expanded={trendExpanded}
        onToggleExpanded={() => setTrendExpanded((v) => !v)}
      />

      {showAdmin && auth.user && (
        <AdminPanel currentUserId={auth.user.id} onClose={() => setShowAdmin(false)} onDataChanged={refresh} />
      )}
    </div>
  );
}
