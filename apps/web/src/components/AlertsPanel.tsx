import { useEffect, useMemo, useState } from 'react';
import { fixAfterStill, formatAge, type AlertHistoryEntry, type OrgTagRow, type TagSnapshot } from '@tagexplore/core';
import * as api from '../api.js';

interface Props {
  /** Tags switched on in the main sidebar list — what this panel actually watches. */
  watchedTagIds: Set<string>;
  snapshots: TagSnapshot[];
  tags: OrgTagRow[];
  now: number;
  /** Same handler the tag list's own rows call — clicking a tag here selects
   *  it the same way, which is what pans the map to its last known location. */
  onSelectTag: (tagId: string) => void;
  /** Whose alert history to show. */
  orgId: string | null;
  /** Bumped when the live stream says this org has new data — the past list refetches on it. */
  liveNonce: number;
}

const STALE_HOURS = 8;
/** How many cleared alerts the Past tab shows. */
const PAST_LIMIT = 100;

type Tab = 'active' | 'past';

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
 * from the tags on screen; **Past** is the server's record of alerts that have
 * since cleared, so what happened overnight is still there in the morning.
 * Renders nothing only when there is neither an active alert nor any history.
 */
export function AlertsPanel({ watchedTagIds, snapshots, tags, now, onSelectTag, orgId, liveNonce }: Props): JSX.Element | null {
  const [expanded, setExpanded] = useState(false);
  const [tab, setTab] = useState<Tab>('active');
  const [past, setPast] = useState<AlertHistoryEntry[] | null>(null);
  const labelFor = useMemo(() => new Map(tags.map((t) => [t.tagId, t.label])), [tags]);

  useEffect(() => setPast(null), [orgId]);
  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    api
      .fetchAlertHistory(orgId, 'past', PAST_LIMIT)
      .then((res) => !cancelled && setPast(res.alerts))
      .catch(() => !cancelled && setPast((prev) => prev ?? []));
    return () => {
      cancelled = true;
    };
  }, [orgId, liveNonce]);

  const alerts = useMemo(() => {
    const staleCutoff = now - STALE_HOURS * 3_600_000;
    // `fix` only on a still alert: the newest GPS fix since the tag went
    // still, or null for "No fix" (none has arrived since).
    const rows: Array<{
      key: string;
      tagId: string;
      message: string;
      since: number;
      fix?: { at: number | null; stillSince: number };
    }> = [];

    for (const tagId of watchedTagIds) {
      const snap = snapshots.find((s) => s.tagId === tagId);
      if (!snap) continue;
      // movementState: 1 = still, 0 = moving. A tag reporting still wins over
      // a stale one — "still" already explains why it hasn't moved, so "not
      // seen in Xh" would just be a second, redundant alarm for the same tag.
      if (snap.movementState === 1) {
        // Whether a GPS fix has come in since the tag went still, which is
        // what says where it actually stopped.
        const stillSince = snap.stillSince ?? snap.lastSeenAt;
        rows.push({
          key: `${tagId}-still`,
          tagId,
          message: 'still',
          since: stillSince,
          fix: { at: fixAfterStill(snap), stillSince },
        });
      } else if (snap.lastSeenAt < staleCutoff) {
        rows.push({
          key: `${tagId}-stale`,
          tagId,
          message: `not seen in ${formatAge(now - snap.lastSeenAt)}`,
          since: snap.lastSeenAt + STALE_HOURS * 3_600_000,
        });
      }
    }
    return rows;
  }, [watchedTagIds, snapshots, now]);

  const pastRows = past ?? [];
  if (alerts.length === 0 && pastRows.length === 0) return null;

  const tagLink = (tagId: string, label: string | null | undefined): JSX.Element => (
    <span
      className="alert-tag"
      role="button"
      tabIndex={0}
      onClick={() => onSelectTag(tagId)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelectTag(tagId);
        }
      }}
    >
      {tagId}
      {label && <span className="tag-label"> {label}</span>}
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
            <button type="button" role="tab" aria-selected={tab === 'active'} data-on={tab === 'active' ? '1' : '0'} onClick={() => setTab('active')}>
              Active ({alerts.length})
            </button>
            <button type="button" role="tab" aria-selected={tab === 'past'} data-on={tab === 'past' ? '1' : '0'} onClick={() => setTab('past')}>
              Past ({pastRows.length}
              {pastRows.length === PAST_LIMIT ? '+' : ''})
            </button>
          </div>

          {tab === 'active' && (
            <div className="alerts-list">
              {alerts.length === 0 && <div className="empty alerts-empty">No active alerts.</div>}
              {alerts.map((a) => (
                <div key={a.key} className="alert-row">
                  <span className="alert-tag-group">
                    {tagLink(a.tagId, labelFor.get(a.tagId))}
                    {a.fix && (
                      <span
                        className={`alert-gps-fix ${a.fix.at !== null ? 'alert-gps-fix-yes' : 'alert-gps-fix-no'}`}
                        title={
                          a.fix.at !== null
                            ? `GPS fix ${formatAge(now - a.fix.at)} ago, after it went still ${formatAge(now - a.fix.stillSince)} ago`
                            : `No GPS fix since it went still ${formatAge(now - a.fix.stillSince)} ago`
                        }
                      >
                        {a.fix.at !== null ? `fix ✓ ${formatAge(now - a.fix.at)} ago` : 'No fix'}
                      </span>
                    )}
                  </span>
                  <span className="alert-message" title={`Since ${timestamp(a.since)}`}>
                    {a.message}
                  </span>
                </div>
              ))}
            </div>
          )}

          {tab === 'past' && (
            <div className="alerts-list">
              {past === null && <div className="empty alerts-empty">Loading…</div>}
              {past !== null && pastRows.length === 0 && <div className="empty alerts-empty">No past alerts yet.</div>}
              {pastRows.map((a) => (
                <div key={a.id} className="alert-row alert-row-past">
                  <span className="alert-tag-group">
                    {tagLink(a.tagId, a.label ?? labelFor.get(a.tagId))}
                    <span className="alert-past-kind">{a.kind === 'still' ? 'still' : 'not seen'}</span>
                  </span>
                  <span
                    className="alert-past-when"
                    title={`${timestamp(a.startedAt)} → ${timestamp(a.endedAt!)} (${formatAge(a.endedAt! - a.startedAt)})`}
                  >
                    {timestamp(a.startedAt)} · {formatAge(a.endedAt! - a.startedAt)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
