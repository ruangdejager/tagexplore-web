import { useEffect, useState } from 'react';
import { formatAge, type AlertHistoryEntry } from '@tagexplore/core';
import * as api from '../api.js';
import { alertText } from '../format.js';
import type { OrgData } from '../useOrgData.js';
import { TagLine } from './TagLine.js';

/** How many cleared alerts the Past list shows. */
const PAST_LIMIT = 100;

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
 * The Alerts tab: **Active** is what is wrong right now (the server's live
 * alert list); **Past** is every alert that has since cleared, newest first,
 * so what happened while nobody was looking is still on record.
 */
export function AlertsView({
  orgId,
  data,
  onOpenTag,
}: {
  orgId: string;
  data: OrgData;
  onOpenTag: (tagId: string) => void;
}): JSX.Element {
  const [tab, setTab] = useState<'active' | 'past'>('active');
  const [past, setPast] = useState<AlertHistoryEntry[] | null>(null);

  useEffect(() => setPast(null), [orgId]);
  // Re-read whenever new data lands: an alert clearing is what adds a row here.
  useEffect(() => {
    let cancelled = false;
    api
      .fetchAlertHistory(orgId, 'past', PAST_LIMIT)
      .then((res) => !cancelled && setPast(res.alerts))
      .catch(() => !cancelled && setPast((prev) => prev ?? []));
    return () => {
      cancelled = true;
    };
  }, [orgId, data.updatedAt]);

  if (data.error && !data.updatedAt) return <p className="empty">{data.error}</p>;
  if (!data.updatedAt) return <p className="empty">Loading…</p>;

  const now = Date.now();
  const alertRows = data.watched.filter((r) => r.alert);
  const labelFor = new Map(data.rows.map((r) => [r.tagId, r.label]));

  return (
    <div className="list-page">
      <div className="summary">
        <div className={`summary-figure ${alertRows.length ? 'bad' : 'good'}`}>{alertRows.length}</div>
        <div className="summary-text">
          <strong>{alertRows.length === 1 ? 'tag needs attention' : 'tags need attention'}</strong>
          <span>
            of {data.watched.length} watched · updated{' '}
            {new Date(data.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>
      </div>

      <div className="segmented" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'active'} data-on={tab === 'active' ? '1' : '0'} onClick={() => setTab('active')}>
          Active ({alertRows.length})
        </button>
        <button type="button" role="tab" aria-selected={tab === 'past'} data-on={tab === 'past' ? '1' : '0'} onClick={() => setTab('past')}>
          Past{past ? ` (${past.length}${past.length === PAST_LIMIT ? '+' : ''})` : ''}
        </button>
      </div>

      {tab === 'active' &&
        (alertRows.length === 0 ? (
          <p className="all-clear">All tags reporting normally.</p>
        ) : (
          <ul className="rows">
            {alertRows.map((row) => (
              <li key={row.tagId}>
                <TagLine row={row} detail={alertText(row.alert!, now)} onOpen={onOpenTag} />
              </li>
            ))}
          </ul>
        ))}

      {tab === 'past' &&
        (past === null ? (
          <p className="empty">Loading…</p>
        ) : past.length === 0 ? (
          <p className="all-clear">No past alerts yet.</p>
        ) : (
          <ul className="rows">
            {past.map((a) => {
              const label = a.label ?? labelFor.get(a.tagId) ?? null;
              return (
                <li key={a.id}>
                  <div className="row">
                    <button type="button" className="row-open" onClick={() => onOpenTag(a.tagId)}>
                      <span className="status-dot quiet" aria-hidden="true" />
                      <span className="row-main">
                        <span className="row-title">
                          <span className="tag-id">{a.tagId}</span>
                          {label && <span className="tag-label">{label}</span>}
                        </span>
                        <span className="row-detail">
                          {a.kind === 'still' ? 'Still' : 'Not seen'} · {timestamp(a.startedAt)} · lasted{' '}
                          {formatAge(a.endedAt! - a.startedAt)}
                        </span>
                      </span>
                      <span className="chevron" aria-hidden="true">
                        ›
                      </span>
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        ))}
    </div>
  );
}
