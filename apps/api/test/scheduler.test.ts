import { describe, expect, it } from 'vitest';
import type { DeviceRow } from '@tagexplore/core';
import { isDue, mostRecentDuePollAt } from '../src/ingest/scheduler.js';

/** The fleet's real setting: 19 hourly reports from 04:10, read 10 minutes later. */
function device(patch: Partial<DeviceRow> = {}): DeviceRow {
  return {
    imei: '866049074634379',
    orgId: 'org-a',
    orgName: 'Org A',
    label: 'Reader',
    active: true,
    reportStartMinute: 4 * 60 + 10,
    reportIntervalMinutes: 60,
    reportCountPerDay: 19,
    pollOffsetMinutes: 10,
    lastIngestAt: null,
    lastIngestStatus: null,
    createdAt: 0,
    ...patch,
  };
}

/** Johannesburg is UTC+2 all year, so a `+02:00` literal is unambiguous. */
const at = (iso: string): number => Date.parse(iso);

describe('mostRecentDuePollAt', () => {
  it('reads each report ten minutes after it: 04:20, 05:20 … 22:20', () => {
    const d = device();
    expect(mostRecentDuePollAt(d, at('2026-09-02T10:25:00+02:00'))).toBe(at('2026-09-02T10:20:00+02:00'));
    // Before this hour's slot, the most recent one is still last hour's.
    expect(mostRecentDuePollAt(d, at('2026-09-02T10:19:59+02:00'))).toBe(at('2026-09-02T09:20:00+02:00'));
    expect(mostRecentDuePollAt(d, at('2026-09-02T04:20:00+02:00'))).toBe(at('2026-09-02T04:20:00+02:00'));
  });

  it('stops at the day’s last report instead of carrying on overnight', () => {
    const d = device();
    // 22:10 is the 19th and final report, so 22:20 stays the newest due poll
    // right through the night.
    expect(mostRecentDuePollAt(d, at('2026-09-02T23:30:00+02:00'))).toBe(at('2026-09-02T22:20:00+02:00'));
    expect(mostRecentDuePollAt(d, at('2026-09-03T02:00:00+02:00'))).toBe(at('2026-09-02T22:20:00+02:00'));
  });

  it('reaches back to yesterday’s last slot before today’s first one', () => {
    const d = device();
    expect(mostRecentDuePollAt(d, at('2026-09-03T04:19:00+02:00'))).toBe(at('2026-09-02T22:20:00+02:00'));
  });

  it('follows a device on a different schedule', () => {
    // Reports at 06:35, every 90 minutes, 5 a day; read 15 minutes later.
    const d = device({
      reportStartMinute: 6 * 60 + 35,
      reportIntervalMinutes: 90,
      reportCountPerDay: 5,
      pollOffsetMinutes: 15,
    });
    // Polls at 06:50, 08:20, 09:50, 11:20, 12:50.
    expect(mostRecentDuePollAt(d, at('2026-09-02T10:00:00+02:00'))).toBe(at('2026-09-02T09:50:00+02:00'));
    expect(mostRecentDuePollAt(d, at('2026-09-02T20:00:00+02:00'))).toBe(at('2026-09-02T12:50:00+02:00'));
  });

  it('handles a device that reports once a day', () => {
    const d = device({ reportStartMinute: 6 * 60, reportIntervalMinutes: 1440, reportCountPerDay: 1 });
    expect(mostRecentDuePollAt(d, at('2026-09-02T18:00:00+02:00'))).toBe(at('2026-09-02T06:10:00+02:00'));
    expect(mostRecentDuePollAt(d, at('2026-09-02T05:00:00+02:00'))).toBe(at('2026-09-01T06:10:00+02:00'));
  });
});

describe('isDue', () => {
  const now = at('2026-09-02T10:25:00+02:00');

  it('is due when it has never run', () => {
    expect(isDue(device(), now)).toBe(true);
  });

  it('is due when the last run predates this slot', () => {
    expect(isDue(device({ lastIngestAt: at('2026-09-02T09:20:30+02:00') }), now)).toBe(true);
  });

  it('is not due again inside the same slot', () => {
    expect(isDue(device({ lastIngestAt: at('2026-09-02T10:20:30+02:00') }), now)).toBe(false);
  });

  it('does not keep re-reading a quiet device overnight', () => {
    const midnight = at('2026-09-03T01:00:00+02:00');
    expect(isDue(device({ lastIngestAt: at('2026-09-02T22:20:30+02:00') }), midnight)).toBe(false);
  });

  it('never runs an inactive device', () => {
    expect(isDue(device({ active: false }), now)).toBe(false);
  });
});
