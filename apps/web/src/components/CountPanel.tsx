import { useState } from 'react';
import { checkedInTagIds, DISCOVERY_WINDOWS, type DiscoveryCountPoint, type DiscoveryWindow, type TagSnapshot } from '@tagexplore/core';
import * as api from '../api.js';

interface Props {
  /**
   * Every tag currently toggled on in the main list — a tag switched off
   * counts for nothing here, the same way it's absent from the map.
   * `snapshots.length` is also the fraction's denominator: "count/total"
   * toggled-on tags, not count against the whole whitelist.
   */
  snapshots: TagSnapshot[];
  now: number;
  orgId: string | null;
  /**
   * Lifted up to `App` rather than owned here: the discovery-state legend
   * colours markers by the same checked-in set this fraction counts, so both
   * need to agree on which window is picked.
   */
  windowChoice: DiscoveryWindow;
  onWindowChange: (window: DiscoveryWindow) => void;
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
export function CountPanel({ snapshots, now, orgId, windowChoice, onWindowChange }: Props): JSX.Element {
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

  return (
    <div className="card count-panel">
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
              <div key={h.bracketAt} className="count-history-row">
                <span>{timestamp(h.bracketAt)}</span>
                <span>{h.count}</span>
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
