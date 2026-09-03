/**
 * Which "unique tag" window the count panel and the discovery-state legend
 * agree on — 'latest' means the most recent discovery round only, the numeric
 * values are hours back from now.
 */
export type DiscoveryWindow = 'latest' | '2' | '4' | '6' | '8' | '12' | '16' | '24';

export const DISCOVERY_WINDOWS: Array<{ value: DiscoveryWindow; label: string }> = [
  { value: 'latest', label: 'Latest discovery' },
  { value: '2', label: 'Last 2h' },
  { value: '4', label: 'Last 4h' },
  { value: '6', label: 'Last 6h' },
  { value: '8', label: 'Last 8h' },
  { value: '12', label: 'Last 12h' },
  { value: '16', label: 'Last 16h' },
  { value: '24', label: 'Last 24h' },
];

/**
 * The tag ids that count as "checked in" for the chosen window — 'latest'
 * means whichever tags share the most recent `lastSeenAt` among the given
 * set, otherwise every tag seen within that many hours of `nowMs`. Shared by
 * the count panel's fraction and the discovery-state legend's marker colour
 * so the two always agree on the same set of tags.
 */
export function checkedInTagIds(
  snapshots: Array<{ tagId: string; lastSeenAt: number }>,
  window: DiscoveryWindow,
  nowMs: number,
): Set<string> {
  if (snapshots.length === 0) return new Set();
  if (window === 'latest') {
    const latest = Math.max(...snapshots.map((s) => s.lastSeenAt));
    return new Set(snapshots.filter((s) => s.lastSeenAt === latest).map((s) => s.tagId));
  }
  const cutoff = nowMs - Number(window) * 3_600_000;
  return new Set(snapshots.filter((s) => s.lastSeenAt >= cutoff).map((s) => s.tagId));
}
