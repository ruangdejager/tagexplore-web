import { useMemo, useState } from 'react';
import { formatAge, type OrgTagRow, type TagSnapshot } from '@tagexplore/core';

interface Props {
  /** Tags switched on in the main sidebar list — what this panel actually watches. */
  watchedTagIds: Set<string>;
  snapshots: TagSnapshot[];
  tags: OrgTagRow[];
  now: number;
}

const STALE_HOURS = 8;

/**
 * Sits directly under the count panel, same corner, same card styling.
 * Collapsed to one line by default — the title and a count are enough to
 * notice something needs attention; the arrow opens the detail. Renders
 * nothing at all when there is nothing to report, rather than a reassuring
 * "no problems" line — an empty corner says that just as well.
 */
export function AlertsPanel({ watchedTagIds, snapshots, tags, now }: Props): JSX.Element | null {
  const [expanded, setExpanded] = useState(false);
  const labelFor = useMemo(() => new Map(tags.map((t) => [t.tagId, t.label])), [tags]);

  const alerts = useMemo(() => {
    const staleCutoff = now - STALE_HOURS * 3_600_000;
    const rows: Array<{ key: string; tagId: string; message: string }> = [];

    for (const tagId of watchedTagIds) {
      const snap = snapshots.find((s) => s.tagId === tagId);
      if (!snap) continue;
      if (snap.lastSeenAt < staleCutoff) {
        rows.push({ key: `${tagId}-stale`, tagId, message: `not seen in ${formatAge(now - snap.lastSeenAt)}` });
      }
      // movementState: 1 = still, 0 = moving.
      if (snap.movementState === 1) {
        rows.push({ key: `${tagId}-still`, tagId, message: 'still' });
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
              <span className="alert-tag">
                {a.tagId}
                {labelFor.get(a.tagId) && <span className="tag-label"> {labelFor.get(a.tagId)}</span>}
              </span>
              <span className="alert-message">{a.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
