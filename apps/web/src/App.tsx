import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OrgTagRow, OrganisationRow, TagSnapshot } from '@tagexplore/core';
import * as api from './api.js';
import { AdminPanel } from './components/AdminPanel.js';
import { AlertsPanel } from './components/AlertsPanel.js';
import { BatteryTrends } from './components/BatteryTrends.js';
import { CountPanel } from './components/CountPanel.js';
import { LoginScreen } from './components/LoginScreen.js';
import { MapLegend } from './components/MapLegend.js';
import { MapView, type MarkerColorMode } from './components/MapView.js';
import { OrgRequestPanel } from './components/OrgRequestPanel.js';
import { TagCard } from './components/TagCard.js';
import { TagList } from './components/TagList.js';
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
export function App(): JSX.Element {
  const auth = useAuth();

  if (auth.status !== 'authed') {
    return <LoginScreen auth={auth} />;
  }
  return <AuthedApp auth={auth} />;
}

function AuthedApp({ auth }: { auth: ReturnType<typeof useAuth> }): JSX.Element {
  const [showAdmin, setShowAdmin] = useState(false);

  const [orgs, setOrgs] = useState<OrganisationRow[]>([]);
  const [viewOrgId, setViewOrgId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [hiddenFromMap, setHiddenFromMap] = useState<Set<string>>(new Set());
  const [heatmapView, setHeatmapView] = useState(false);
  const [heatmapHours, setHeatmapHours] = useState(72);
  const [colorMode, setColorMode] = useState<MarkerColorMode>('age');
  const [selectedTagId, setSelectedTagId] = useState<string | null>(null);
  const [fitNonce, setFitNonce] = useState(0);
  const [trendTags, setTrendTags] = useState<Set<string>>(new Set());
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

  // Tags are never time-filtered — every whitelisted tag always shows its
  // latest known state, so the fetch window here is just a generous ceiling,
  // not a user-facing setting. The heatmap gets its own window below.
  const { snapshots, devices, loading, error, refresh } = useSnapshots(orgId, SNAPSHOT_WINDOW_HOURS, canSeeData);
  const heatPoints = useHeatPoints(orgId, heatmapHours, heatmapView);

  // "3h ago" has to keep counting without a refetch, so the clock the list and
  // card format against ticks on its own.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    api.fetchOrgs().then((res) => setOrgs(res.orgs)).catch(() => setOrgs([]));
  }, [isAdmin, showAdmin]);

  useEffect(() => {
    if (!canSeeData) return;
    api.fetchOrgTags(orgId).then((res) => setWhitelist(res.tags)).catch(() => setWhitelist([]));
  }, [canSeeData, orgId]);

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

  useEffect(() => {
    if (!prefsLoaded) return;
    void api.savePreferences({ hiddenTagIds: [...hiddenFromMap], colorMode, lastOrgId: orgId }).catch(() => {});
  }, [prefsLoaded, hiddenFromMap, colorMode, orgId]);

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

  /** The map's markers: the same list, minus whatever the per-tag toggle hid. */
  const mapTags = useMemo(() => visible.filter((tag) => !hiddenFromMap.has(tag.tagId)), [visible, hiddenFromMap]);

  // The same per-tag list toggle also decides what counts as "toggled on" for
  // the unique-tag count and the alerts panel — a tag switched off is left out
  // of both, the same way it's left off the map.
  const toggledSnapshots = useMemo(() => snapshots.filter((s) => !hiddenFromMap.has(s.tagId)), [snapshots, hiddenFromMap]);
  const watchedTagIds = useMemo(() => new Set(toggledSnapshots.map((s) => s.tagId)), [toggledSnapshots]);

  const selected = visible.find((t) => t.tagId === selectedTagId) ?? null;
  const withFix = visible.filter((t) => t.lat !== null).length;

  const toggleMapVisibility = useCallback((tagId: string): void => {
    setHiddenFromMap((prev) => {
      const next = new Set(prev);
      if (next.has(tagId)) next.delete(tagId);
      else next.add(tagId);
      return next;
    });
  }, []);

  const toggleTrendTag = useCallback((tagId: string): void => {
    setTrendTags((prev) => {
      const next = new Set(prev);
      if (next.has(tagId)) next.delete(tagId);
      else next.add(tagId);
      return next;
    });
  }, []);

  return (
    <div id="app">
      <header>
        <button className="mark" onClick={() => setFitNonce((n) => n + 1)} title="Fit the map to every tag shown">
          Tag<span>·</span>Explore
        </button>

        <div className="tally">
          <b>{visible.length}</b> tags shown · <b>{withFix}</b> with a fix · <b>{devices.length}</b> devices
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
        <div className="filters">
          <div className="filter-row">
            <button className="pill" data-on={heatmapView ? '1' : '0'} onClick={() => setHeatmapView((v) => !v)}>
              Heatmap view
            </button>
            <button className="pill" onClick={refresh} title="Reload now">
              Refresh
            </button>
          </div>

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

          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="tag id or label"
            autoComplete="off"
          />
        </div>

        {!canSeeData && !isAdmin && <OrgRequestPanel />}
        <TagList
          snapshots={visible}
          selectedTagId={selectedTagId}
          onSelect={setSelectedTagId}
          now={now}
          hiddenFromMap={hiddenFromMap}
          onToggleMapVisibility={toggleMapVisibility}
        />
      </aside>

      <MapView
        snapshots={mapTags}
        selectedTagId={selectedTagId}
        onSelect={setSelectedTagId}
        fitNonce={fitNonce}
        autoFitKey={orgId}
        heatmapView={heatmapView}
        heatPoints={heatPoints}
        colorMode={colorMode}
      >
        <div className="map-topleft">
          <CountPanel snapshots={toggledSnapshots} now={now} orgId={orgId} />
          <AlertsPanel watchedTagIds={watchedTagIds} snapshots={snapshots} tags={whitelist} now={now} />
          {selected && (
            <TagCard
              tag={selected}
              devices={devices}
              now={now}
              onClose={() => setSelectedTagId(null)}
              onShowTrend={(tagId) => setTrendTags(new Set([tagId]))}
            />
          )}
        </div>
        <MapLegend mode={colorMode} onChange={setColorMode} />
      </MapView>

      <BatteryTrends
        orgId={orgId}
        tags={whitelist}
        selected={trendTags}
        onToggle={toggleTrendTag}
        onSelectOnly={(ids) => setTrendTags(new Set(ids))}
      />

      {showAdmin && auth.user && (
        <AdminPanel currentUserId={auth.user.id} onClose={() => setShowAdmin(false)} onDataChanged={refresh} />
      )}
    </div>
  );
}
