import { useEffect, useMemo, useState } from 'react';
import {
  BATTERY_LABEL,
  batteryLevel,
  fixAfterStill,
  formatAge,
  type AlertHistoryEntry,
  type OrgTagRow,
  type TagSnapshot,
} from '@tagexplore/core';
import * as api from '../api.js';
import { MapsLinkButton } from './MapsLinkButton.js';

interface Props {
  /** Tags switched on in the main sidebar list — what this panel actually watches. */
  watchedTagIds: Set<string>;
  snapshots: TagSnapshot[];
  tags: OrgTagRow[];
  now: number;
  /** Same handler the tag list's own rows call — selecting a tag pans the map to its last known location. */
  onSelectTag: (tagId: string) => void;
  /** Whose alert history to show. */
  orgId: string | null;
  /** Bumped when the live stream says this org has new data — the history list refetches on it. */
  liveNonce: number;
}

const STALE_HOURS = 8;
/** How many cleared alerts the History tab shows. */
const HISTORY_LIMIT = 100;
const NO_FIX_MESSAGE = 'There is no GPS fix for this alert.';

type Tab = 'active' | 'history';

interface ActiveAlert {
  key: string;
  tagId: string;
  kind: 'still' | 'stale';
  message: string;
  since: number;
  snap: TagSnapshot;
  /** The fix behind the alert: since it went still, or the last one for a stale tag. Null for "No fix". */
  fixAt: number | null;
  lat: number | null;
  lon: number | null;
}

function timestamp(ms: number): string {
  return new Date(ms).toLocaleString('en-ZA', {
    timeZone: 'Africa/Johannesburg',
    hour12: false,
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Sits directly under the count panel, same corner, same card styling.
 * Collapsed to one line by default — the title and a count are enough to
 * notice something needs attention; the arrow opens the detail.
 *
 * Two tabs: **Active** is what is wrong right now, worked out in the browser
 * from the tags on screen; **History** is the server's record of alerts that
 * have since cleared. Clicking a row opens its details in place: an active
 * alert offers "Show on map" and Google Maps, a past one Google Maps only.
 * Renders nothing only when there is neither an active alert nor any history.
 */
export function AlertsPanel({ watchedTagIds, snapshots, tags, now, onSelectTag, orgId, liveNonce }: Props): JSX.Element | null {
  const [expanded, setExpanded] = useState(false);
  const [tab, setTab] = useState<Tab>('active');
  const [history, setHistory] = useState<AlertHistoryEntry[] | null>(null);
  const [openActive, setOpenActive] = useState<string | null>(null);
  const [openPast, setOpenPast] = useState<number | null>(null);
  const labelFor = useMemo(() => new Map(tags.map((t) => [t.tagId, t.label])), [tags]);

  useEffect(() => {
    setHistory(null);
    setOpenActive(null);
    setOpenPast(null);
  }, [orgId]);
  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    api
      .fetchAlertHistory(orgId, 'past', HISTORY_LIMIT)
      .then((res) => !cancelled && setHistory(res.alerts))
      .catch(() => !cancelled && setHistory((prev) => prev ?? []));
    return () => {
      cancelled = true;
    };
  }, [orgId, liveNonce]);

  const alerts = useMemo(() => {
    const staleCutoff = now - STALE_HOURS * 3_600_000;
    const rows: ActiveAlert[] = [];
    for (const tagId of watchedTagIds) {
      const snap = snapshots.find((s) => s.tagId === tagId);
      if (!snap) continue;
      // movementState: 1 = still, 0 = moving. A tag reporting still wins over
      // a stale one — "still" already explains why it hasn't moved, so "not
      // seen in Xh" would just be a second, redundant alarm for the same tag.
      if (snap.movementState === 1) {
        // Only a fix since it went still says where it actually stopped.
        const fix = fixAfterStill(snap);
        rows.push({
          key: `${tagId}-still`,
          tagId,
          kind: 'still',
          message: 'still',
          since: snap.stillSince ?? snap.lastSeenAt,
          snap,
          fixAt: fix,
          lat: fix !== null ? snap.lat : null,
          lon: fix !== null ? snap.lon : null,
        });
      } else if (snap.lastSeenAt < staleCutoff) {
        rows.push({
          key: `${tagId}-stale`,
          tagId,
          kind: 'stale',
          message: `not seen in ${formatAge(now - snap.lastSeenAt)}`,
          since: snap.lastSeenAt + STALE_HOURS * 3_600_000,
          snap,
          fixAt: snap.lat !== null ? snap.fixAt : null,
          lat: snap.lat,
          lon: snap.lon,
        });
      }
    }
    return rows;
  }, [watchedTagIds, snapshots, now]);

  const historyRows = history ?? [];
  if (alerts.length === 0 && historyRows.length === 0) return null;

  const active = openActive !== null ? (alerts.find((a) => a.key === openActive) ?? null) : null;
  const past = openPast !== null ? (historyRows.find((a) => a.id === openPast) ?? null) : null;

  const nameOf = (tagId: string, label: string | null | undefined): JSX.Element => (
    <span className="alert-tag">
      {tagId}
      {label && <span className="tag-label"> {label}</span>}
    </span>
  );

  const fixBadge = (fixAt: number | null, title: string): JSX.Element => (
    <span className={`alert-gps-fix ${fixAt !== null ? 'alert-gps-fix-yes' : 'alert-gps-fix-no'}`} title={title}>
      {fixAt !== null ? `fix ✓ ${formatAge(now - fixAt)} ago` : 'No fix'}
    </span>
  );

  return (
    <div className="card alerts-card">
      <button className="alerts-card-header" onClick={() => setExpanded((v) => !v)}>
        <span className={`alert-badge${alerts.length === 0 ? ' alert-badge-quiet' : ''}`} aria-hidden="true">
          !
        </span>
        <span className="panel-title" style={{ padding: 0 }}>
          Alerts ({alerts.length})
        </span>
        <span className="chevron">{expanded ? '▾' : '▸'}</span>
      </button>

      {expanded && (
        <>
          <div className="alerts-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'active'}
              data-on={tab === 'active' ? '1' : '0'}
              onClick={() => setTab('active')}
            >
              Active ({alerts.length})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'history'}
              data-on={tab === 'history' ? '1' : '0'}
              onClick={() => setTab('history')}
            >
              History ({historyRows.length}
              {historyRows.length === HISTORY_LIMIT ? '+' : ''})
            </button>
          </div>

          {tab === 'active' && active && (
            <div className="alert-detail">
              <div className="alert-detail-head">
                {nameOf(active.tagId, labelFor.get(active.tagId))}
                <button type="button" className="card-close" aria-label="Close" onClick={() => setOpenActive(null)}>
                  ×
                </button>
              </div>
              <dl>
                <dt>Alert</dt>
                <dd className="alert-message">{active.kind === 'still' ? 'Still' : 'Not seen'}</dd>
                <dt>{active.kind === 'still' ? 'Still since' : 'Stale since'}</dt>
                <dd>
                  {timestamp(active.since)} · {formatAge(now - active.since)}
                </dd>
                <dt>Last seen</dt>
                <dd>
                  {timestamp(active.snap.lastSeenAt)} · {formatAge(now - active.snap.lastSeenAt)} ago
                </dd>
                <dt>{active.kind === 'still' ? 'Fix since still' : 'Last fix'}</dt>
                <dd>{active.fixAt !== null ? `${timestamp(active.fixAt)} · ${formatAge(now - active.fixAt)} ago` : 'No fix'}</dd>
                {active.lat !== null && active.lon !== null && (
                  <>
                    <dt>Position</dt>
                    <dd>
                      {active.lat.toFixed(5)}, {active.lon.toFixed(5)}
                    </dd>
                  </>
                )}
                {active.snap.batteryMv !== null && (
                  <>
                    <dt>Battery</dt>
                    <dd>
                      {(active.snap.batteryMv / 1000).toFixed(2)}V · {BATTERY_LABEL[batteryLevel(active.snap.batteryMv)]}
                    </dd>
                  </>
                )}
              </dl>
              <div className="card-actions">
                <button type="button" className="pill" onClick={() => onSelectTag(active.tagId)}>
                  Show on map
                </button>
                <MapsLinkButton lat={active.lat} lon={active.lon} label="Google Maps" noFixMessage={NO_FIX_MESSAGE} />
              </div>
            </div>
          )}

          {tab === 'active' && !active && (
            <div className="alerts-list">
              {alerts.length === 0 && <div className="empty alerts-empty">No active alerts.</div>}
              {alerts.map((a) => (
                <button key={a.key} type="button" className="alert-row" onClick={() => setOpenActive(a.key)}>
                  <span className="alert-tag-group">
                    {nameOf(a.tagId, labelFor.get(a.tagId))}
                    {a.kind === 'still' &&
                      fixBadge(
                        a.fixAt,
                        a.fixAt !== null
                          ? `GPS fix ${formatAge(now - a.fixAt)} ago, after it went still ${formatAge(now - a.since)} ago`
                          : `No GPS fix since it went still ${formatAge(now - a.since)} ago`,
                      )}
                  </span>
                  <span className="alert-message" title={`Since ${timestamp(a.since)}`}>
                    {a.message}
                  </span>
                </button>
              ))}
            </div>
          )}

          {tab === 'history' && past && (
            <div className="alert-detail">
              <div className="alert-detail-head">
                {nameOf(past.tagId, past.label ?? labelFor.get(past.tagId))}
                <button type="button" className="card-close" aria-label="Close" onClick={() => setOpenPast(null)}>
                  ×
                </button>
              </div>
              <dl>
                <dt>Alert</dt>
                <dd>{past.kind === 'still' ? 'Still' : 'Not seen'}</dd>
                <dt>Started</dt>
                <dd>{timestamp(past.startedAt)}</dd>
                <dt>Cleared</dt>
                <dd>{timestamp(past.endedAt!)}</dd>
                <dt>Lasted</dt>
                <dd>{formatAge(past.endedAt! - past.startedAt)}</dd>
                <dt>GPS fix</dt>
                <dd>{past.fixAt !== null ? timestamp(past.fixAt) : 'No fix'}</dd>
                {past.lat !== null && past.lon !== null && (
                  <>
                    <dt>Position</dt>
                    <dd>
                      {past.lat.toFixed(5)}, {past.lon.toFixed(5)}
                    </dd>
                  </>
                )}
              </dl>
              <div className="card-actions">
                <MapsLinkButton lat={past.lat} lon={past.lon} label="Google Maps" noFixMessage={NO_FIX_MESSAGE} />
              </div>
            </div>
          )}

          {tab === 'history' && !past && (
            <div className="alerts-list">
              {history === null && <div className="empty alerts-empty">Loading…</div>}
              {history !== null && historyRows.length === 0 && <div className="empty alerts-empty">No alert history yet.</div>}
              {historyRows.map((a) => (
                <button key={a.id} type="button" className="alert-row alert-row-past" onClick={() => setOpenPast(a.id)}>
                  <span className="alert-tag-group">
                    {nameOf(a.tagId, a.label ?? labelFor.get(a.tagId))}
                    <span className="alert-past-kind">{a.kind === 'still' ? 'still' : 'not seen'}</span>
                    <span className={`alert-gps-fix ${a.fixAt !== null ? 'alert-gps-fix-yes' : 'alert-gps-fix-no'}`}>
                      {a.fixAt !== null ? 'fix ✓' : 'No fix'}
                    </span>
                  </span>
                  <span
                    className="alert-past-when"
                    title={`${timestamp(a.startedAt)} → ${timestamp(a.endedAt!)} (${formatAge(a.endedAt! - a.startedAt)})`}
                  >
                    {timestamp(a.startedAt)} · {formatAge(a.endedAt! - a.startedAt)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
