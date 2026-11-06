import { useMemo, useState } from 'react';
import { fixAfterStill, formatAge, type OrgTagRow, type TagSnapshot } from '@tagexplore/core';

interface Props {
  /** Tags switched on in the main sidebar list — what this panel actually watches. */
  watchedTagIds: Set<string>;
  snapshots: TagSnapshot[];
  tags: OrgTagRow[];
  now: number;
  /** Same handler the tag list's own rows call — clicking a tag here selects
   *  it the same way, which is what pans the map to its last known location. */
  onSelectTag: (tagId: string) => void;
}

const STALE_HOURS = 8;

/**
 * Sits directly under the count panel, same corner, same card styling.
 * Collapsed to one line by default — the title and a count are enough to
 * notice something needs attention; the arrow opens the detail. Renders
 * nothing at all when there is nothing to report, rather than a reassuring
 * "no problems" line — an empty corner says that just as well.
 */
export function AlertsPanel({ watchedTagIds, snapshots, tags, now, onSelectTag }: Props): JSX.Element | null {
  const [expanded, setExpanded] = useState(false);
  const labelFor = useMemo(() => new Map(tags.map((t) => [t.tagId, t.label])), [tags]);

  const alerts = useMemo(() => {
    const staleCutoff = now - STALE_HOURS * 3_600_000;
    // `fix` only on a still alert: the newest GPS fix since the tag went
    // still, or null for "No fix" (none has arrived since).
    const rows: Array<{ key: string; tagId: string; message: string; fix?: { at: number | null; stillSince: number } }> = [];

    for (const tagId of watchedTagIds) {
      const snap = snapshots.find((s) => s.tagId === tagId);
      if (!snap) continue;
      // movementState: 1 = still, 0 = moving. A tag reporting still wins over
      // a stale one — "still" already explains why it hasn't moved, so "not
      // seen in Xh" would just be a second, redundant alarm for the same tag.
      if (snap.movementState === 1) {
        // Whether a GPS fix has come in since the tag went still, which is
        // what says where it actually stopped.
        rows.push({
          key: `${tagId}-still`,
          tagId,
          message: 'still',
          fix: { at: fixAfterStill(snap), stillSince: snap.stillSince ?? snap.lastSeenAt },
        });
      } else if (snap.lastSeenAt < staleCutoff) {
        rows.push({ key: `${tagId}-stale`, tagId, message: `not seen in ${formatAge(now - snap.lastSeenAt)}` });
      }
    }
    return rows;
  }, [watchedTagIds, snapshots, now]);

  if (alerts.length === 0) return null;

  return (
    <div className="card alerts-card">
      <button className="alerts-card-header" onClick={() => setExpanded((v) => !v)}>
        <span className="alert-badge" aria-hidden="true">
          !
        </span>
        <span className="panel-title" style={{ padding: 0 }}>
          Alerts ({alerts.length})
        </span>
        <span className="chevron">{expanded ? '▾' : '▸'}</span>
      </button>

      {expanded && (
        <div className="alerts-list">
          {alerts.map((a) => (
            <div key={a.key} className="alert-row">
              <span className="alert-tag-group">
                <span
                  className="alert-tag"
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelectTag(a.tagId)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onSelectTag(a.tagId);
                    }
                  }}
                >
                  {a.tagId}
                  {labelFor.get(a.tagId) && <span className="tag-label"> {labelFor.get(a.tagId)}</span>}
                </span>
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
              <span className="alert-message">{a.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
