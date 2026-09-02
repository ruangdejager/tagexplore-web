/**
 * How stale a tag's last GPS fix is, and what colour that gets on the map.
 *
 * The buckets match the Telegram bot's map pins (<2h, <24h, <3d, older) so the
 * two views tell the same story; the colours are this app's own palette rather
 * than the bot's emoji set.
 */
export type PositionAge = 'live' | 'recent' | 'stale' | 'old' | 'none';

export const AGE_THRESHOLD_MS: Record<Exclude<PositionAge, 'old' | 'none'>, number> = {
  live: 2 * 3_600_000,
  recent: 24 * 3_600_000,
  stale: 72 * 3_600_000,
};

export const AGE_COLOR: Record<PositionAge, string> = {
  live: '#4FBF8B',
  recent: '#E9AE2F',
  stale: '#E2731B',
  old: '#C13615',
  none: '#9AA08C',
};

export const AGE_LABEL: Record<PositionAge, string> = {
  live: 'Under 2h',
  recent: 'Under 24h',
  stale: 'Under 3 days',
  old: 'Over 3 days',
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
