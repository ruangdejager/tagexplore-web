/**
 * How stale a tag's last GPS fix is, and what colour that gets on the map:
 * green under 4h, yellow under 12h, orange under 24h, red beyond that.
 */
export type PositionAge = 'live' | 'recent' | 'stale' | 'old' | 'none';

export const AGE_THRESHOLD_MS: Record<Exclude<PositionAge, 'old' | 'none'>, number> = {
  live: 4 * 3_600_000,
  recent: 12 * 3_600_000,
  stale: 24 * 3_600_000,
};

export const AGE_COLOR: Record<PositionAge, string> = {
  live: '#4FBF8B',
  recent: '#E9AE2F',
  stale: '#E2731B',
  old: '#C13615',
  none: '#9AA08C',
};

export const AGE_LABEL: Record<PositionAge, string> = {
  live: 'Under 4h',
  recent: 'Under 12h',
  stale: 'Under 24h',
  old: 'Over 24h',
  none: 'No fix',
};

export function positionAge(fixMs: number | null | undefined, nowMs: number = Date.now()): PositionAge {
  if (fixMs === null || fixMs === undefined) return 'none';
  const age = nowMs - fixMs;
  if (age < AGE_THRESHOLD_MS.live) return 'live';
  if (age < AGE_THRESHOLD_MS.recent) return 'recent';
  if (age < AGE_THRESHOLD_MS.stale) return 'stale';
  return 'old';
}

export function ageColor(fixMs: number | null | undefined, nowMs: number = Date.now()): string {
  return AGE_COLOR[positionAge(fixMs, nowMs)];
}

/** "4m", "3h 20m", "6d" — compact enough for a map label or a list row. */
export function formatAge(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rem = minutes % 60;
    return rem ? `${hours}h ${rem}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours ? `${days}d ${remHours}h` : `${days}d`;
}

/**
 * The map's "GPS fix" colouring, shared by the desktop's GPS-age legend and
 * the mobile map: green when the tag's fix came in the latest discovery round
 * itself, then light blue under 4h, yellow 4–12h, orange 12–24h and red past
 * 24h. Grey only for a tag that has never had a fix.
 */
export type GpsFixBand = 'latest' | 'under4h' | 'under12h' | 'under24h' | 'over24h' | 'none';

export const GPS_FIX_COLOR: Record<GpsFixBand, string> = {
  latest: '#4FBF8B',
  under4h: '#6EC3F2',
  under12h: '#E9D02F',
  under24h: '#E2731B',
  over24h: '#C13615',
  none: '#9AA08C',
};

/** Legend rows, in order. "No fix" is left out: a tag without one has no dot to colour. */
export const GPS_FIX_LEGEND: Array<{ band: GpsFixBand; label: string }> = [
  { band: 'latest', label: 'Fix in latest discovery' },
  { band: 'under4h', label: '< 4h' },
  { band: 'under12h', label: '4h – 12h' },
  { band: 'under24h', label: '12h – 24h' },
  { band: 'over24h', label: '> 24h' },
];

/**
 * `latestRoundIds` is the set of tags in the latest discovery round being
 * shown (see `checkedInTagIds(…, 'latest', …)`); a tag in it whose newest
 * reading carried the fix is green.
 */
export function gpsFixBand(
  snap: { tagId: string; fixAt: number | null; lastSeenAt: number },
  latestRoundIds: Set<string>,
  nowMs: number,
): GpsFixBand {
  if (snap.fixAt === null) return 'none';
  if (latestRoundIds.has(snap.tagId) && snap.fixAt >= snap.lastSeenAt) return 'latest';
  const age = nowMs - snap.fixAt;
  if (age < 4 * 3_600_000) return 'under4h';
  if (age < 12 * 3_600_000) return 'under12h';
  if (age < 24 * 3_600_000) return 'under24h';
  return 'over24h';
}
