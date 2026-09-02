/**
 * A device's daily report schedule, as the settings API describes it, and the
 * poll times it implies.
 *
 * The schedule is a bounded series rather than an open-ended repeat: the device
 * makes `reportCountPerDay` reports a day, the first `reportStartMinute`
 * minutes past local midnight and each one `reportIntervalMinutes` after the
 * last. Its log is read `pollOffsetMinutes` after each report, because the
 * upload lands a little behind the report itself.
 *
 * The fleet currently runs 19 hourly reports from 04:10 — 04:10 through 22:10 —
 * which with a 10-minute offset means reading at 04:20 through 22:20 and
 * leaving the device alone overnight.
 */
export interface ReportSchedule {
  reportStartMinute: number;
  reportIntervalMinutes: number;
  reportCountPerDay: number;
  pollOffsetMinutes: number;
}

/** `HH:MM` from minutes past midnight, wrapping past a day boundary. */
export function formatMinuteOfDay(minutes: number): string {
  const wrapped = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Minutes past midnight from `HH:MM`, or null if it is not a time. */
export function parseMinuteOfDay(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

/** Every report time in one day, as minutes past local midnight. */
export function reportTimesOfDay(schedule: ReportSchedule): number[] {
  const count = Math.max(1, Math.round(schedule.reportCountPerDay));
  const interval = Math.max(1, Math.round(schedule.reportIntervalMinutes));
  return Array.from({ length: count }, (_, i) => schedule.reportStartMinute + i * interval);
}

/** Every log-read time in one day, as minutes past local midnight. */
export function pollTimesOfDay(schedule: ReportSchedule): number[] {
  return reportTimesOfDay(schedule).map((m) => m + schedule.pollOffsetMinutes);
}

/** `04:20, 05:20 … 22:20 · 19/day` — the whole schedule in one line. */
export function describeSchedule(schedule: ReportSchedule): string {
  const times = pollTimesOfDay(schedule);
  const first = times[0];
  const last = times[times.length - 1];
  if (first === undefined || last === undefined) return '—';

  const count = `${times.length}/day`;
  if (times.length === 1) return `${formatMinuteOfDay(first)} · ${count}`;
  const second = times[1] as number;
  if (times.length === 2) return `${formatMinuteOfDay(first)}, ${formatMinuteOfDay(second)} · ${count}`;
  return `${formatMinuteOfDay(first)}, ${formatMinuteOfDay(second)} … ${formatMinuteOfDay(last)} · ${count}`;
}
