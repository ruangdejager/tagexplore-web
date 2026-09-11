import { useMemo, useState } from 'react';
import { formatAge, type OrgTagRow, type TagSnapshot } from '@tagexplore/core';

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
    const rows: Array<{ key: string; tagId: string; message: string; hasGpsFix?: boolean }> = [];

    for (const tagId of watchedTagIds) {
      const snap = snapshots.find((s) => s.tagId === tagId);
      if (!snap) continue;
      // movementState: 1 = still, 0 = moving. A tag reporting still wins over
      // a stale one — "still" already explains why it hasn't moved, so "not
      // seen in Xh" would just be a second, redundant alarm for the same tag.
      if (snap.movementState === 1) {
        // fixAt is the latest GPS-carrying reading's bracket; it matches
        // lastSeenAt only when that latest (still) reading itself had a fix.
        rows.push({ key: `${tagId}-still`, tagId, message: 'still', hasGpsFix: snap.fixAt === snap.lastSeenAt });
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
                {a.hasGpsFix !== undefined && (
                  <span className={`alert-gps-fix ${a.hasGpsFix ? 'alert-gps-fix-yes' : 'alert-gps-fix-no'}`}>
                    {' '}gps fix {a.hasGpsFix ? '✓' : '✗'}
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
