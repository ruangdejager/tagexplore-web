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
  /** Devices switched off in the main list — the count history's own fetch
   *  needs this too, since it comes from a separate query than `snapshots`. */
  excludeDeviceImeis?: string[];
  /**
   * Whether this account may open a round's raw data — `dev` and `admin` only.
   * The server enforces the same rule; this just keeps the icon off a client's
   * screen instead of offering them a button that answers 403.
   */
  canSeeRawData: boolean;
  /**
   * Opens a round's raw data. Owned by `App` rather than rendered here: this
   * panel sits inside a `.card`, whose `backdrop-filter` makes it the
   * containing block for anything `position: fixed` inside it — a full-screen
   * overlay opened from here would be trapped in the 272px card.
   */
  onShowRaw: (bracketAt: number) => void;
}

function timestamp(ms: number): string {
  return new Date(ms).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', hour12: false });
}

/** e.g. `1m26s`, or `59s` under a minute. What the number *measures* depends on
 *  how the round arrived — the firmware's own campaign timer on a pushed round,
 *  the old bracket-to-last-block estimate on a scraped one. */
function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m${String(s).padStart(2, '0')}s`;
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
  excludeDeviceImeis,
  canSeeRawData,
  onShowRaw,
}: Props): JSX.Element {
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<DiscoveryCountPoint[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);

  const count = checkedInTagIds(snapshots, windowChoice, now).size;

  const toggleHistory = (): void => {
    if (!showHistory && history === null) {
      setHistoryLoading(true);
      api
        .fetchDiscoveryCounts(orgId, 200, excludeDeviceImeis)
        .then((res) => setHistory(res.counts))
        .catch(() => setHistory([]))
        .finally(() => setHistoryLoading(false));
    }
    setShowHistory((v) => !v);
  };

  // Once loaded, keeps itself in sync with every live poll instead of going
  // stale until the page is refreshed — `latestDiscoveryAt` changes exactly
  // when a new round actually lands, live poll or manual Refresh, regardless
  // of which round is currently being browsed. A device switched off refetches
  // the same way, since that changes every row's own count too.
  useEffect(() => {
    if (history === null) return;
    api
      .fetchDiscoveryCounts(orgId, 200, excludeDeviceImeis)
      .then((res) => setHistory(res.counts))
      .catch(() => {});
  }, [latestDiscoveryAt, orgId, excludeDeviceImeis]);

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
              <div key={h.bracketAt} className={`count-history-row${h.bracketAt === historyAt ? ' active' : ''}`}>
                <button
                  type="button"
                  className="count-history-pick"
                  onClick={() => onSelectHistory(h.bracketAt)}
                  title={
                    h.receivedAt !== null
                      ? `Data arrived ${timestamp(h.receivedAt)} — click to show this round's snapshot on the map`
                      : `Scraped from the log into the ${timestamp(h.bracketAt)} bracket — click to show this round's snapshot on the map`
                  }
                >
                  {/* The exact arrival time when the unit pushed the round to
                      us; only a scraped round falls back to its bracket, which
                      is the only time it has. */}
                  <span>{timestamp(h.receivedAt ?? h.bracketAt)}</span>
                  <span className="count-history-duration">
                    {h.durationSeconds !== null ? formatDuration(h.durationSeconds) : '—'}
                  </span>
                  <span className="count-history-count">{h.count}</span>
                </button>
                {canSeeRawData && (
                  <button
                    type="button"
                    className="count-history-info"
                    onClick={() => onShowRaw(h.bracketAt)}
                    title="Show this round's raw data"
                    aria-label={`Raw data for the round at ${timestamp(h.receivedAt ?? h.bracketAt)}`}
                  >
                    i
                  </button>
                )}
              </div>
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
