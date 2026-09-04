import { useEffect, useState } from 'react';
import { checkedInTagIds, DISCOVERY_WINDOWS, type DiscoveryCountPoint, type DiscoveryWindow, type TagSnapshot } from '@tagexplore/core';
import * as api from '../api.js';

interface Props {
  /**
   * Whatever the fraction actually counts against — the live toggled-on set
   * when showing live, or the browsed round's own set otherwise, same as
   * what the map itself is plotting. `snapshots.length` is the fraction's
   * denominator: tags in that set, not the whole whitelist.
   */
  snapshots: TagSnapshot[];
  /** The reference time `windowChoice`'s numeric windows count back from —
   *  the browsed round's own time while browsing history, live "now" otherwise. */
  now: number;
  orgId: string | null;
  /**
   * Lifted up to `App` rather than owned here: the discovery-state legend
   * colours markers by the same checked-in set this fraction counts, so both
   * need to agree on which window is picked.
   */
  windowChoice: DiscoveryWindow;
  onWindowChange: (window: DiscoveryWindow) => void;
  /** Which past discovery round the map is currently showing — `null` means
   *  the live/latest state, which is also what the LIVE badge reflects. */
  historyAt: number | null;
  onSelectHistory: (bracketAt: number) => void;
  onGoLive: () => void;
  /** Always the *live* latest discovery's time, regardless of what round is
   *  being browsed — shown beside LIVE as what it would jump back to. */
  latestDiscoveryAt: number | null;
}

function timestamp(ms: number): string {
  return new Date(ms).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', hour12: false });
}

/**
 * Every whitelisted tag already loads with its own latest reading regardless
 * of the window picked here, so "how many unique tags" is just counting that
 * already-loaded set two ways — no extra request for either "latest" or an
 * hour window. Only the scrollable history (one row per past discovery round)
 * needs its own fetch, and only once asked for.
 */
export function CountPanel({
  snapshots,
  now,
  orgId,
  windowChoice,
  onWindowChange,
  historyAt,
  onSelectHistory,
  onGoLive,
  latestDiscoveryAt,
}: Props): JSX.Element {
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<DiscoveryCountPoint[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);

  const count = checkedInTagIds(snapshots, windowChoice, now).size;

  const toggleHistory = (): void => {
    if (!showHistory && history === null) {
      setHistoryLoading(true);
      api
        .fetchDiscoveryCounts(orgId)
        .then((res) => setHistory(res.counts))
        .catch(() => setHistory([]))
        .finally(() => setHistoryLoading(false));
    }
    setShowHistory((v) => !v);
  };

  // Once loaded, keeps itself in sync with every live poll instead of going
  // stale until the page is refreshed — `latestDiscoveryAt` changes exactly
  // when a new round actually lands, live poll or manual Refresh, regardless
  // of which round is currently being browsed.
  useEffect(() => {
    if (history === null) return;
    api
      .fetchDiscoveryCounts(orgId)
      .then((res) => setHistory(res.counts))
      .catch(() => {});
  }, [latestDiscoveryAt, orgId]);

  const isLive = historyAt === null;

  return (
    <div className="card count-panel">
      <div className="live-status">
        {latestDiscoveryAt !== null && (
          <span className="live-at" title="Time of the latest discovery round">
            {timestamp(latestDiscoveryAt)}
          </span>
        )}
        <button
          type="button"
          className="live-badge"
          data-live={isLive ? '1' : '0'}
          onClick={onGoLive}
          title={isLive ? 'Showing the latest snapshot' : 'Jump back to the latest snapshot'}
        >
          <span className="live-dot" aria-hidden="true" />
          LIVE
        </button>
      </div>
      <h3>
        {count}/{snapshots.length}
      </h3>
      <div className="sub">unique tags</div>

      <select value={windowChoice} onChange={(e) => onWindowChange(e.target.value as DiscoveryWindow)}>
        {DISCOVERY_WINDOWS.map((w) => (
          <option key={w.value} value={w.value}>
            {w.label}
          </option>
        ))}
      </select>

      <button className="pill" style={{ width: '100%', marginTop: 8 }} onClick={toggleHistory}>
        {showHistory ? 'Hide history' : 'Count history'}
      </button>

      {showHistory && (
        <div className="count-history">
          {historyLoading ? (
            <div className="empty" style={{ padding: '10px 0' }}>
              Loading…
            </div>
          ) : history && history.length > 0 ? (
            history.map((h) => (
              <button
                key={h.bracketAt}
                type="button"
                className={`count-history-row${h.bracketAt === historyAt ? ' active' : ''}`}
                onClick={() => onSelectHistory(h.bracketAt)}
                title="Show this round's snapshot on the map"
              >
                <span>{timestamp(h.bracketAt)}</span>
                <span>{h.count}</span>
              </button>
            ))
          ) : (
            <div className="empty" style={{ padding: '10px 0' }}>
              No discovery history yet.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
