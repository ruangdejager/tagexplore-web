import { useEffect, useRef, useState } from 'react';
import { checkedInTagIds, DISCOVERY_WINDOWS, type DiscoveryCountPoint, type DiscoveryWindow, type TagSnapshot } from '@tagexplore/core';
import * as api from '../api.js';

/** Rows per history fetch; scrolling near the bottom fetches the next page back. */
const HISTORY_PAGE = 50;
const LOAD_MORE_THRESHOLD = 40;
const MINIMISED_KEY = 'tx-m-count-minimised';

function readMinimised(): boolean {
  try {
    return localStorage.getItem(MINIMISED_KEY) === '1';
  } catch {
    return false;
  }
}

function saveMinimised(value: boolean): void {
  try {
    localStorage.setItem(MINIMISED_KEY, value ? '1' : '0');
  } catch {
    // Not remembered; it opens expanded next time.
  }
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

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  return `${m}m${String(seconds % 60).padStart(2, '0')}s`;
}

/**
 * The desktop count panel, laid out for a phone: unique tags heard in the
 * chosen window over the switched-on tags, the LIVE badge with the latest
 * round's time, and the scrollable per-round history. Tapping a history row
 * shows that round on the map; tapping LIVE goes back to now.
 */
export function CountBlock(props: {
  orgId: string;
  /** Switched-on tags' snapshots: live, or as of the picked round. */
  snapshots: TagSnapshot[];
  now: number;
  windowChoice: DiscoveryWindow;
  onWindowChange: (w: DiscoveryWindow) => void;
  historyAt: number | null;
  onSelectHistory: (bracketAt: number) => void;
  onGoLive: () => void;
  /**
   * Opens a round's raw data. Only passed for `dev` and `admin` accounts; the
   * icon isn't drawn without it. The sheet itself lives in App, because this
   * block's backdrop blur would trap a full-screen overlay inside it.
   */
  onShowRaw?: ((bracketAt: number) => void) | undefined;
  /** Changes whenever new data has been loaded, so the latest round and the first page refresh. */
  dataVersion: number | null;
  streamConnected: boolean;
}): JSX.Element {
  const { orgId, dataVersion } = props;
  const [open, setOpen] = useState(false);
  // Remembered on this phone, so a minimised block stays out of the way.
  const [minimised, setMinimisedState] = useState(readMinimised);
  const setMinimised = (value: boolean): void => {
    saveMinimised(value);
    setMinimisedState(value);
  };
  const [history, setHistory] = useState<DiscoveryCountPoint[] | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [latest, setLatest] = useState<DiscoveryCountPoint | null>(null);
  const generation = useRef(0);

  const count = checkedInTagIds(props.snapshots, props.windowChoice, props.now).size;
  const isLive = props.historyAt === null;

  // A different organisation starts the history over.
  useEffect(() => {
    generation.current += 1;
    setHistory(null);
    setOpen(false);
    setHasMore(true);
  }, [orgId]);

  useEffect(() => {
    let cancelled = false;
    api
      .fetchDiscoveryCounts(orgId, 1)
      .then((res) => !cancelled && setLatest(res.counts[0] ?? null))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [orgId, dataVersion]);

  // Opened, or new data arrived while open: refresh the newest page and keep
  // any older pages already scrolled into view.
  useEffect(() => {
    if (!open) return;
    const gen = generation.current;
    api
      .fetchDiscoveryCounts(orgId, HISTORY_PAGE)
      .then((res) => {
        if (gen !== generation.current) return;
        setHistory((prev) => {
          const pageOldest = res.counts[res.counts.length - 1]?.bracketAt;
          if (!prev || pageOldest === undefined || res.counts.length < HISTORY_PAGE) return res.counts;
          return [...res.counts, ...prev.filter((h) => h.bracketAt < pageOldest)];
        });
        if (res.counts.length < HISTORY_PAGE) setHasMore(false);
      })
      .catch(() => setHistory((prev) => prev ?? []));
  }, [open, orgId, dataVersion]);

  const loadMore = (): void => {
    const oldest = history?.[history.length - 1]?.bracketAt;
    if (oldest === undefined || !hasMore || loadingMore) return;
    const gen = generation.current;
    setLoadingMore(true);
    api
      .fetchDiscoveryCounts(orgId, HISTORY_PAGE, oldest)
      .then((res) => {
        if (gen !== generation.current) return;
        setHistory((prev) => {
          const tail = prev?.[prev.length - 1]?.bracketAt ?? Infinity;
          return [...(prev ?? []), ...res.counts.filter((h) => h.bracketAt < tail)];
        });
        setHasMore(res.counts.length === HISTORY_PAGE);
      })
      .catch(() => {})
      .finally(() => setLoadingMore(false));
  };

  if (minimised) {
    return (
      <button type="button" className="map-block map-block-mini count-mini" onClick={() => setMinimised(false)} aria-label="Show the count">
        <span className="live-badge" data-live={isLive ? '1' : '0'} data-stream={props.streamConnected ? 'up' : 'down'}>
          <span className="badge-dot" aria-hidden="true" />
        </span>
        <span className="count-mini-figure">
          {count}/{props.snapshots.length}
        </span>
        <span className="mini-label">unique tags</span>
      </button>
    );
  }

  return (
    <div className="map-block count-block">
      <div className="count-top">
        <button
          type="button"
          className="live-badge"
          data-live={isLive ? '1' : '0'}
          data-stream={props.streamConnected ? 'up' : 'down'}
          onClick={props.onGoLive}
          aria-label={isLive ? 'Showing the latest round' : 'Back to the latest round'}
        >
          <span className="badge-dot" aria-hidden="true" />
          {isLive ? (props.streamConnected ? 'LIVE' : 'RECONNECTING') : 'BACK TO LIVE'}
        </button>
        <span className="count-time">
          {isLive
            ? latest
              ? timestamp(latest.receivedAt ?? latest.bracketAt)
              : ''
            : timestamp(props.historyAt!)}
        </span>
        <MinimiseButton label="Minimise the count" onClick={() => setMinimised(true)} />
      </div>

      <div className="count-main">
        <div className="count-figure">
          {count}/{props.snapshots.length}
          <span>unique tags</span>
        </div>
        <select
          className="count-window"
          value={props.windowChoice}
          onChange={(e) => props.onWindowChange(e.target.value as DiscoveryWindow)}
          aria-label="Count window"
        >
          {DISCOVERY_WINDOWS.map((w) => (
            <option key={w.value} value={w.value}>
              {w.label}
            </option>
          ))}
        </select>
      </div>

      <button type="button" className="count-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {open ? 'Hide history' : 'Count history'}
        <span aria-hidden="true">{open ? '▴' : '▾'}</span>
      </button>

      {open && (
        <div
          className="count-history"
          onScroll={(e) => {
            const el = e.currentTarget;
            if (el.scrollTop + el.clientHeight >= el.scrollHeight - LOAD_MORE_THRESHOLD) loadMore();
          }}
        >
          {history === null ? (
            <div className="count-history-note">Loading…</div>
          ) : history.length === 0 ? (
            <div className="count-history-note">No discovery history yet.</div>
          ) : (
            <>
              {history.map((h) => (
                <div key={h.bracketAt} className={`count-history-line ${h.bracketAt === props.historyAt ? 'active' : ''}`}>
                  <button type="button" className="count-history-row" onClick={() => props.onSelectHistory(h.bracketAt)}>
                    <span>{timestamp(h.receivedAt ?? h.bracketAt)}</span>
                    <span className="count-history-duration">
                      {h.durationSeconds !== null ? formatDuration(h.durationSeconds) : '—'}
                    </span>
                    <span className="count-history-count">{h.count}</span>
                  </button>
                  {props.onShowRaw && (
                    <button
                      type="button"
                      className="count-history-info"
                      onClick={() => props.onShowRaw!(h.bracketAt)}
                      aria-label={`Raw data for the round at ${timestamp(h.receivedAt ?? h.bracketAt)}`}
                    >
                      i
                    </button>
                  )}
                </div>
              ))}
              {loadingMore && <div className="count-history-note">Loading more…</div>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** The ✕ that shrinks a map block to its pill. Shared by the count and the map functions blocks. */
export function MinimiseButton({ label, onClick }: { label: string; onClick: () => void }): JSX.Element {
  return (
    <button type="button" className="block-minimise" onClick={onClick} aria-label={label}>
      <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
        <path d="M3 3l6 6M9 3l-6 6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    </button>
  );
}
