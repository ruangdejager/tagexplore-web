import { toApiDate } from '@tagexplore/core';
import type { Config } from '../config.js';

/**
 * The Farmranger logs API returns a device's syslog as an array of entries,
 * each carrying a chunk of log text. Joining them back together is what the
 * parser expects, and it is also what makes the undated-anchor date resolution
 * work — a bare discovery anchor takes its date from the dated lines around it,
 * which may well sit in a different entry.
 */
interface LogEntry {
  logText?: string;
}

export function buildLogsUrl(config: Config, imei: string, from: Date, to: Date): string {
  return `${config.logsApiBase}${imei}/logs?From=${toApiDate(from)}&To=${toApiDate(to)}`;
}

export async function fetchUnitLogText(config: Config, imei: string, from: Date, to: Date): Promise<string> {
  const url = buildLogsUrl(config, imei, from, to);
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Logs API returned HTTP ${res.status} for ${imei}: ${body.slice(0, 200)}`);
  }
  const entries = (await res.json()) as unknown;
  if (!Array.isArray(entries)) {
    throw new Error(`Unexpected logs API response for ${imei} — expected a JSON array.`);
  }
  return (entries as LogEntry[]).map((e) => e.logText ?? '').join('\n');
}

/**
 * A device's daily report schedule, which is what decides when we read its log.
 *
 * The settings API describes it as a bounded series rather than an open-ended
 * repeat: `dailyReportCountPerDay` reports a day, the first at
 * `dailyReportStartTime`, each `dailyReportInterval` after the last. The fleet
 * currently runs 19 hourly reports from 04:10, i.e. 04:10 through 22:10 — after
 * which the device is quiet until the next morning.
 */
export interface DeviceSchedule {
  /** Minutes past local midnight of the first report. */
  reportStartMinute: number;
  reportIntervalMinutes: number;
  reportCountPerDay: number;
}

/**
 * Settings are a paged collection, newest first — the request asks for a single
 * item so the current settings are `items[0]`.
 */
export function buildSettingsUrl(config: Config, imei: string): string {
  return (
    `${config.settingsApiBase}${imei}/settings` +
    '?PageNumber=1&PageSize=1&Sort=auditInfo.createdTimestamp&Order=desc'
  );
}

export async function fetchDeviceSchedule(config: Config, imei: string): Promise<DeviceSchedule | null> {
  if (!config.settingsApiBase || !config.settingsApiToken) return null;

  const res = await fetch(buildSettingsUrl(config, imei), {
    headers: { authorization: `Bearer ${config.settingsApiToken}` },
  });
  if (!res.ok) {
    throw new Error(`Settings API returned HTTP ${res.status} for ${imei}.`);
  }
  return readSchedule((await res.json()) as unknown);
}

/** `HH:MM:SS` (or `HH:MM`) to whole minutes. Null for anything else. */
function parseClock(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  // Seconds are ignored rather than rounded: the schedule is minute-grained and
  // a report at :10:00 is the only form the API has ever returned.
  return hours * 60 + minutes;
}

/**
 * Pulls the schedule out of a settings response.
 *
 * Returns null — leaving the device on its stored schedule — rather than
 * guessing when any of the three fields is missing or unusable, so a response
 * shape change shows up as "schedule unchanged" instead of a device that
 * silently stops being polled.
 */
export function readSchedule(payload: unknown): DeviceSchedule | null {
  if (!payload || typeof payload !== 'object') return null;
  const items = (payload as { items?: unknown }).items;
  const settings = Array.isArray(items) ? (items[0] as Record<string, unknown> | undefined) : undefined;
  if (!settings) return null;

  const reportStartMinute = parseClock(settings['dailyReportStartTime']);
  const reportIntervalMinutes = parseClock(settings['dailyReportInterval']);
  const count = Number(settings['dailyReportCountPerDay']);

  if (reportStartMinute === null) return null;
  // A zero interval would make the series infinite at one instant, and a count
  // below one would mean the device never reports at all — neither is a
  // schedule we can poll on.
  if (reportIntervalMinutes === null || reportIntervalMinutes < 1) return null;
  if (!Number.isFinite(count) || count < 1) return null;

  return { reportStartMinute, reportIntervalMinutes, reportCountPerDay: Math.round(count) };
}
