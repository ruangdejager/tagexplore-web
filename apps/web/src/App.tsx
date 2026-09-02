import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AGE_COLOR,
  AGE_LABEL,
  positionAge,
  type OrgTagRow,
  type OrganisationRow,
  type PositionAge,
  type TagSnapshot,
} from '@tagexplore/core';
import * as api from './api.js';
import { AdminPanel } from './components/AdminPanel.js';
import { AuthModal } from './components/AuthModal.js';
import { BatteryTrends } from './components/BatteryTrends.js';
import { MapView } from './components/MapView.js';
import { TagCard } from './components/TagCard.js';
import { TagList } from './components/TagList.js';
import { useAuth } from './state/useAuth.js';
import { useSnapshots } from './state/useSnapshots.js';

/** The windows worth offering: a shift, a day, and the spans the fleet reports over. */
const WINDOWS: Array<{ hours: number; label: string }> = [
  { hours: 6, label: 'Last 6 hours' },
  { hours: 24, label: 'Last 24 hours' },
  { hours: 72, label: 'Last 3 days' },
  { hours: 168, label: 'Last 7 days' },
  { hours: 720, label: 'Last 30 days' },
];

const AGE_ORDER: PositionAge[] = ['live', 'recent', 'stale', 'old', 'none'];

export function App(): JSX.Element {
  const auth = useAuth();
  const [authMode, setAuthMode] = useState<'login' | 'signup' | null>(null);
  const [showAdmin, setShowAdmin] = useState(false);

  const [orgs, setOrgs] = useState<OrganisationRow[]>([]);
  const [viewOrgId, setViewOrgId] = useState<string | null>(null);
  const [hours, setHours] = useState(72);
  const [query, setQuery] = useState('');
  const [hiddenAges, setHiddenAges] = useState<Set<PositionAge>>(new Set());
  const [selectedTagId, setSelectedTagId] = useState<string | null>(null);
  const [fitNonce, setFitNonce] = useState(0);
  const [trendTags, setTrendTags] = useState<Set<string>>(new Set());
  const [whitelist, setWhitelist] = useState<OrgTagRow[]>([]);
  const [now, setNow] = useState(() => Date.now());

  const isAdmin = auth.user?.role === 'admin';
  // An admin can look at any organisation; everyone else is pinned to their own,
  // and the server enforces that regardless of what is sent.
  const orgId = isAdmin ? viewOrgId ?? auth.user?.orgId ?? null : auth.user?.orgId ?? null;
  const canSeeData = auth.status === 'authed' && orgId !== null;

  const { snapshots, devices, loading, error, refresh } = useSnapshots(orgId, hours, canSeeData);

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
    if (!canSeeData) {
      setWhitelist([]);
      return;
    }
    api.fetchOrgTags(orgId).then((res) => setWhitelist(res.tags)).catch(() => setWhitelist([]));
  }, [canSeeData, orgId]);

  const ageCounts = useMemo(() => {
    const counts = new Map<PositionAge, number>(AGE_ORDER.map((a) => [a, 0]));
    for (const tag of snapshots) {
      const age = positionAge(tag.fixAt, now);
      counts.set(age, (counts.get(age) ?? 0) + 1);
    }
    return counts;
  }, [snapshots, now]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return snapshots.filter((tag: TagSnapshot) => {
      if (hiddenAges.has(positionAge(tag.fixAt, now))) return false;
      if (!needle) return true;
      return tag.tagId.toLowerCase().includes(needle) || (tag.label ?? '').toLowerCase().includes(needle);
    });
  }, [snapshots, query, hiddenAges, now]);

  const selected = visible.find((t) => t.tagId === selectedTagId) ?? null;
  const withFix = visible.filter((t) => t.lat !== null).length;

  const toggleAge = (age: PositionAge): void =>
    setHiddenAges((prev) => {
      const next = new Set(prev);
      if (next.has(age)) next.delete(age);
      else next.add(age);
      return next;
    });

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
          {isAdmin && orgs.length > 0 && (
            <select
              className="pill"
              value={orgId ?? ''}
              onChange={(e) => {
                setViewOrgId(e.target.value || null);
                setSelectedTagId(null);
                setTrendTags(new Set());
              }}
              title="Look at another organisation"
            >
              <option value="">— pick an organisation —</option>
              {orgs.map((org) => (
                <option key={org.id} value={org.id}>
                  {org.name}
                </option>
              ))}
            </select>
          )}

          {auth.status === 'authed' ? (
            <>
              {isAdmin && (
                <button className="pill" onClick={() => setShowAdmin(true)}>
                  Admin
                </button>
              )}
              <button className="pill" onClick={() => void auth.logout()}>
                {auth.user?.username} · log out
              </button>
            </>
          ) : (
            <button className="pill" onClick={() => setAuthMode('login')}>
              Log in
            </button>
          )}
        </div>
      </header>

      <aside>
        <div className="filters">
          <div className="chips">
            {AGE_ORDER.map((age) => (
              <button key={age} className="chip" data-on={hiddenAges.has(age) ? '0' : '1'} onClick={() => toggleAge(age)}>
                <span className="dot" style={{ background: AGE_COLOR[age] }} />
                {AGE_LABEL[age]}
                <span className="count">{ageCounts.get(age) ?? 0}</span>
              </button>
            ))}
          </div>

          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="tag id or label"
            autoComplete="off"
          />

          <div className="filter-row">
            <select value={hours} onChange={(e) => setHours(Number(e.target.value))}>
              {WINDOWS.map((w) => (
                <option key={w.hours} value={w.hours}>
                  {w.label}
                </option>
              ))}
            </select>
            <button className="pill" onClick={refresh} title="Reload now">
              Refresh
            </button>
          </div>
        </div>

        {canSeeData ? (
          <TagList snapshots={visible} selectedTagId={selectedTagId} onSelect={setSelectedTagId} now={now} />
        ) : (
          <div className="list">
            <div className="empty">
              {auth.status === 'checking'
                ? 'Checking your session…'
                : auth.status === 'anonymous'
                  ? 'Log in to see your organisation’s tags.'
                  : isAdmin
                    ? 'Pick an organisation to look at, or add one in Admin.'
                    : 'Your account is not in an organisation yet — an admin needs to add you to one.'}
            </div>
          </div>
        )}
      </aside>

      <MapView
        snapshots={visible}
        selectedTagId={selectedTagId}
        onSelect={setSelectedTagId}
        fitNonce={fitNonce}
        autoFitKey={orgId}
      >
        {selected && (
          <TagCard
            tag={selected}
            devices={devices}
            now={now}
            onClose={() => setSelectedTagId(null)}
            onShowTrend={(tagId) => setTrendTags(new Set([tagId]))}
          />
        )}
        <div className="legend">
          {AGE_ORDER.map((age) => (
            <div key={age}>
              <i style={{ background: AGE_COLOR[age] }} />
              {AGE_LABEL[age]}
            </div>
          ))}
        </div>
      </MapView>

      <BatteryTrends
        orgId={orgId}
        tags={whitelist}
        selected={trendTags}
        onToggle={toggleTrendTag}
        onSelectOnly={(ids) => setTrendTags(new Set(ids))}
      />

      {authMode && (
        <AuthModal
          mode={authMode}
          error={auth.error}
          onModeChange={(mode) => {
            auth.clearError();
            setAuthMode(mode);
          }}
          onSubmit={authMode === 'login' ? auth.login : auth.signup}
          onClose={() => {
            auth.clearError();
            setAuthMode(null);
          }}
        />
      )}

      {showAdmin && auth.user && (
        <AdminPanel currentUserId={auth.user.id} onClose={() => setShowAdmin(false)} onDataChanged={refresh} />
      )}
    </div>
  );
}
