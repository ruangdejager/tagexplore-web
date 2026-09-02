/**
 * Battery thresholds and colours, shared by the map markers, the tag list and
 * the trend chart so they never disagree. Values carried over unchanged from
 * the Telegram bot, where they were tuned against real fleet readings.
 *
 * Thresholds (mV):
 *   >= 3800      → good      (healthy)
 *   3600 – 3800  → ok        (normal working range)
 *   3500 – 3600  → low       (watch)
 *   < 3500       → critical
 */
export const BATTERY_GOOD_MIN = 3800;
export const BATTERY_OK_MIN = 3600;
export const BATTERY_LOW_MIN = 3500;

export type BatteryLevel = 'good' | 'ok' | 'low' | 'critical' | 'unknown';

export const BATTERY_COLOR: Record<BatteryLevel, string> = {
  good: '#4FBF8B',
  ok: '#3E9AD8',
  low: '#E9AE2F',
  critical: '#C13615',
  unknown: '#9AA08C',
};

export const BATTERY_LABEL: Record<BatteryLevel, string> = {
  good: 'Fully charged',
  ok: 'Good',
  low: 'Watch',
  critical: 'Low',
  unknown: 'Unknown',
};

export function batteryLevel(mv: number | null | undefined): BatteryLevel {
  if (mv === null || mv === undefined || Number.isNaN(mv)) return 'unknown';
  if (mv >= BATTERY_GOOD_MIN) return 'good';
  if (mv >= BATTERY_OK_MIN) return 'ok';
  if (mv >= BATTERY_LOW_MIN) return 'low';
  return 'critical';
}

export function batteryColor(mv: number | null | undefined): string {
  return BATTERY_COLOR[batteryLevel(mv)];
}
