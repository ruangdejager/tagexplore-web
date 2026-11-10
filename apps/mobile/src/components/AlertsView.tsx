import { useEffect, useState } from 'react';
import { BATTERY_LABEL, batteryLevel, formatAge, type AlertHistoryEntry, type TagAlert } from '@tagexplore/core';
import * as api from '../api.js';
import { alertText } from '../format.js';
import type { OrgData, TagRow } from '../useOrgData.js';
import { MapsLinkButton } from './MapsLinkButton.js';
import { Sheet } from './Sheet.js';
import { TagLine } from './TagLine.js';

/** How many cleared alerts the History list shows. */
const HISTORY_LIMIT = 100;
const NO_FIX_MESSAGE = 'There is no GPS fix for this alert.';

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

/** When the alert began: the start of the still streak, or when the tag crossed the 8h line. */
function alertSince(alert: TagAlert): number {
  return alert.kind === 'still' ? (alert.stillSince ?? alert.lastSeenAt) : alert.lastSeenAt + 8 * 3_600_000;
}

/**
 * The Alerts tab: **Active** is what is wrong right now (the server's live
 * alert list); **History** is every alert that has since cleared, newest
 * first. Tapping a row opens its details: an active alert offers "Show on
 * map" and Google Maps, a past one Google Maps only.
 */
export function AlertsView({
  orgId,
  data,
  onShowOnMap,
}: {
  orgId: string;
  data: OrgData;
  onShowOnMap: (tagId: string) => void;
}): JSX.Element {
  const [tab, setTab] = useState<'active' | 'history'>('active');
  const [history, setHistory] = useState<AlertHistoryEntry[] | null>(null);
  const [openActive, setOpenActive] = useState<string | null>(null);
  const [openPast, setOpenPast] = useState<AlertHistoryEntry | null>(null);

  useEffect(() => {
    setHistory(null);
    setOpenActive(null);
    setOpenPast(null);
  }, [orgId]);
  // Re-read whenever new data lands: an alert clearing is what adds a row here.
  useEffect(() => {
    let cancelled = false;
    api
      .fetchAlertHistory(orgId, 'past', HISTORY_LIMIT)
      .then((res) => !cancelled && setHistory(res.alerts))
      .catch(() => !cancelled && setHistory((prev) => prev ?? []));
    return () => {
      cancelled = true;
    };
  }, [orgId, data.updatedAt]);

  if (data.error && !data.updatedAt) return <p className="empty">{data.error}</p>;
  if (!data.updatedAt) return <p className="empty">Loading…</p>;

  const now = Date.now();
  const alertRows = data.watched.filter((r) => r.alert);
  const labelFor = new Map(data.rows.map((r) => [r.tagId, r.label]));
  const activeRow = openActive !== null ? (alertRows.find((r) => r.tagId === openActive) ?? null) : null;

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
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'active'}
          data-on={tab === 'active' ? '1' : '0'}
          onClick={() => setTab('active')}
        >
          Active ({alertRows.length})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'history'}
          data-on={tab === 'history' ? '1' : '0'}
          onClick={() => setTab('history')}
        >
          History{history ? ` (${history.length}${history.length === HISTORY_LIMIT ? '+' : ''})` : ''}
        </button>
      </div>

      {tab === 'active' &&
        (alertRows.length === 0 ? (
          <p className="all-clear">All tags reporting normally.</p>
        ) : (
          <ul className="rows">
            {alertRows.map((row) => (
              <li key={row.tagId}>
                <TagLine row={row} detail={alertText(row.alert!, now)} onOpen={setOpenActive} />
              </li>
            ))}
          </ul>
        ))}

      {tab === 'history' &&
        (history === null ? (
          <p className="empty">Loading…</p>
        ) : history.length === 0 ? (
          <p className="all-clear">No alert history yet.</p>
        ) : (
          <ul className="rows">
            {history.map((a) => {
              const label = a.label ?? labelFor.get(a.tagId) ?? null;
              return (
                <li key={a.id}>
                  <div className="row">
                    <button type="button" className="row-open" onClick={() => setOpenPast(a)}>
                      <span className="status-dot quiet" aria-hidden="true" />
                      <span className="row-main">
                        <span className="row-title">
                          <span className="tag-id">{a.tagId}</span>
                          {label && <span className="tag-label">{label}</span>}
                        </span>
                        <span className="row-detail">
                          {a.kind === 'still' ? 'Still' : 'Not seen'} · {timestamp(a.startedAt)} · lasted{' '}
                          {formatAge(a.endedAt! - a.startedAt)} ·{' '}
                          <span className={a.fixAt !== null ? 'fix-yes' : 'fix-no'}>{a.fixAt !== null ? 'fix ✓' : 'No fix'}</span>
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

      {activeRow && (
        <ActiveAlertSheet
          row={activeRow}
          now={now}
          onShowOnMap={() => {
            setOpenActive(null);
            onShowOnMap(activeRow.tagId);
          }}
          onClose={() => setOpenActive(null)}
        />
      )}
      {openPast && (
        <PastAlertSheet alert={openPast} label={openPast.label ?? labelFor.get(openPast.tagId) ?? null} onClose={() => setOpenPast(null)} />
      )}
    </div>
  );
}

function SheetHead(props: { title: string; sub: string | null; onClose: () => void; badge?: string }): JSX.Element {
  return (
    <div className="sheet-head">
      <div>
        <div className="sheet-title">{props.title}</div>
        {props.sub && <div className="sheet-sub">{props.sub}</div>}
      </div>
      {props.badge && <span className="pill bad">{props.badge}</span>}
      <button type="button" className="map-popup-x" aria-label="Close" onClick={props.onClose}>
        ×
      </button>
    </div>
  );
}

function Facts({ rows }: { rows: Array<[string, React.ReactNode]> }): JSX.Element {
  return (
    <dl className="facts">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function ActiveAlertSheet(props: { row: TagRow; now: number; onShowOnMap: () => void; onClose: () => void }): JSX.Element {
  const { row, now } = props;
  const alert = row.alert!;
  const since = alertSince(alert);
  const mv = row.snap?.batteryMv ?? null;
  const rows: Array<[string, React.ReactNode]> = [
    ['Alert', alert.kind === 'still' ? 'Still' : 'Not seen'],
    [alert.kind === 'still' ? 'Still since' : 'Stale since', `${timestamp(since)} · ${formatAge(now - since)}`],
    ['Last seen', `${timestamp(alert.lastSeenAt)} · ${formatAge(now - alert.lastSeenAt)} ago`],
    [
      alert.kind === 'still' ? 'Fix since still' : 'Last fix',
      <span className={alert.fixAt !== null ? 'fix-yes' : 'fix-no'}>
        {alert.fixAt !== null ? `✓ ${timestamp(alert.fixAt)}` : 'No fix'}
      </span>,
    ],
  ];
  if (alert.lat !== null && alert.lon !== null) {
    rows.push(['Position', <span className="mono">{`${alert.lat.toFixed(6)}, ${alert.lon.toFixed(6)}`}</span>]);
  }
  if (mv !== null) rows.push(['Battery', `${(mv / 1000).toFixed(2)}V · ${BATTERY_LABEL[batteryLevel(mv)]}`]);

  return (
    <Sheet aboveDock onClose={props.onClose} label={`Alert for tag ${row.tagId}`}>
      <SheetHead title={row.tagId} sub={row.label} badge={alert.kind === 'still' ? 'Still' : 'Not seen'} onClose={props.onClose} />
      <Facts rows={rows} />
      <div className="button-row">
        <button type="button" className="primary" onClick={props.onShowOnMap}>
          Show on map
        </button>
        <MapsLinkButton lat={alert.lat} lon={alert.lon} label="Google Maps" noFixMessage={NO_FIX_MESSAGE} />
      </div>
    </Sheet>
  );
}

function PastAlertSheet(props: { alert: AlertHistoryEntry; label: string | null; onClose: () => void }): JSX.Element {
  const { alert } = props;
  const rows: Array<[string, React.ReactNode]> = [
    ['Alert', alert.kind === 'still' ? 'Still' : 'Not seen'],
    ['Started', timestamp(alert.startedAt)],
    ['Cleared', timestamp(alert.endedAt!)],
    ['Lasted', formatAge(alert.endedAt! - alert.startedAt)],
    [
      'GPS fix',
      <span className={alert.fixAt !== null ? 'fix-yes' : 'fix-no'}>{alert.fixAt !== null ? `✓ ${timestamp(alert.fixAt)}` : 'No fix'}</span>,
    ],
  ];
  if (alert.lat !== null && alert.lon !== null) {
    rows.push(['Position', <span className="mono">{`${alert.lat.toFixed(6)}, ${alert.lon.toFixed(6)}`}</span>]);
  }
  return (
    <Sheet aboveDock onClose={props.onClose} label={`Past alert for tag ${alert.tagId}`}>
      <SheetHead title={alert.tagId} sub={props.label} onClose={props.onClose} />
      <Facts rows={rows} />
      <div className="button-row">
        <MapsLinkButton lat={alert.lat} lon={alert.lon} label="Open in Google Maps" noFixMessage={NO_FIX_MESSAGE} />
      </div>
    </Sheet>
  );
}
