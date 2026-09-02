/**
 * Farmranger devices, and the API in front of them, both speak
 * Africa/Johannesburg wall-clock time — a fixed UTC+2 with no DST. The server
 * this app runs on almost certainly does not (Railway is UTC), so every
 * conversion is done explicitly here rather than via the host's local clock.
 */
export const JHB_OFFSET_MS = 2 * 60 * 60 * 1000;

export const MONTHS: Record<string, string> = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
};

export const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

export interface JhbParts {
  /** `DD-Mon-YYYY`. */
  date: string;
  /** `HH:MM:SS`. */
  time: string;
  /** `YYYY-MM-DDTHH:MM:SS+02:00`. */
  iso: string;
}

/** Formats a UTC instant (epoch ms) as Johannesburg-local date/time/ISO parts. */
export function epochToJhb(epochMs: number): JhbParts {
  const shifted = new Date(epochMs + JHB_OFFSET_MS);
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  const mon = MONTH_NAMES[shifted.getUTCMonth()] as string;
  const year = shifted.getUTCFullYear();
  const time = [shifted.getUTCHours(), shifted.getUTCMinutes(), shifted.getUTCSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
  return { date: `${day}-${mon}-${year}`, time, iso: `${year}-${MONTHS[mon]}-${day}T${time}+02:00` };
}

/** `YYYY-MM-DDTHH:MM` in Johannesburg wall-clock time — the format the logs API expects. */
export function toApiDate(d: Date): string {
  const shifted = new Date(d.getTime() + JHB_OFFSET_MS);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}` +
    `T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`
  );
}

/** Epoch ms of Johannesburg-local midnight, `daysAgo` calendar days before today. */
export function jhbMidnightMsDaysAgo(daysAgo: number, nowMs: number = Date.now()): number {
  const { date } = epochToJhb(nowMs);
  const [day, mon, year] = date.split('-') as [string, string, string];
  const todayMidnightUtcMs = Date.UTC(Number(year), Number(MONTHS[mon]) - 1, Number(day)) - JHB_OFFSET_MS;
  return todayMidnightUtcMs - daysAgo * 86_400_000;
}
