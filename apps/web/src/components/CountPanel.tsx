import { useMemo, useState } from 'react';
import type { DiscoveryCountPoint, TagSnapshot } from '@tagexplore/core';
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
}

type WindowChoice = 'latest' | '2' | '4' | '6' | '8' | '12' | '16' | '24';

const WINDOWS: Array<{ value: WindowChoice; label: string }> = [
  { value: 'latest', label: 'Latest discovery' },
  { value: '2', label: 'Last 2h' },
  { value: '4', label: 'Last 4h' },
  { value: '6', label: 'Last 6h' },
  { value: '8', label: 'Last 8h' },
  { value: '12', label: 'Last 12h' },
  { value: '16', label: 'Last 16h' },
  { value: '24', label: 'Last 24h' },
];

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
export function CountPanel({ snapshots, now, orgId }: Props): JSX.Element {
  const [windowChoice, setWindowChoice] = useState<WindowChoice>('latest');
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<DiscoveryCountPoint[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);

  const count = useMemo(() => {
    if (snapshots.length === 0) return 0;
    if (windowChoice === 'latest') {
      const latest = Math.max(...snapshots.map((s) => s.lastSeenAt));
      return snapshots.filter((s) => s.lastSeenAt === latest).length;
    }
    const cutoff = now - Number(windowChoice) * 3_600_000;
    return snapshots.filter((s) => s.lastSeenAt >= cutoff).length;
  }, [snapshots, windowChoice, now]);

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

      <select value={windowChoice} onChange={(e) => setWindowChoice(e.target.value as WindowChoice)}>
        {WINDOWS.map((w) => (
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
