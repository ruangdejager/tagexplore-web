import { describe, expect, it } from 'vitest';
import {
  batteryLevel,
  describeSchedule,
  epochToJhb,
  formatAge,
  formatMinuteOfDay,
  jhbMidnightMsDaysAgo,
  parseMinuteOfDay,
  parseTagIdList,
  pollTimesOfDay,
  positionAge,
  reportTimesOfDay,
  toApiDate,
} from '@tagexplore/core';

describe('batteryLevel', () => {
  it('buckets on the fleet thresholds', () => {
    expect(batteryLevel(4010)).toBe('good');
    expect(batteryLevel(3800)).toBe('good');
    expect(batteryLevel(3799)).toBe('ok');
    expect(batteryLevel(3600)).toBe('ok');
    expect(batteryLevel(3599)).toBe('low');
    expect(batteryLevel(3500)).toBe('low');
    expect(batteryLevel(3499)).toBe('critical');
    expect(batteryLevel(null)).toBe('unknown');
  });
});

describe('positionAge', () => {
  const now = Date.parse('2026-08-28T12:00:00Z');

  it('buckets a fix by how long ago it was reported', () => {
    expect(positionAge(now - 60 * 60_000, now)).toBe('live');
    expect(positionAge(now - 5 * 3_600_000, now)).toBe('recent');
    expect(positionAge(now - 40 * 3_600_000, now)).toBe('stale');
    expect(positionAge(now - 100 * 3_600_000, now)).toBe('old');
    expect(positionAge(null, now)).toBe('none');
  });
});

describe('formatAge', () => {
  it('drops to the coarsest unit that still reads clearly', () => {
    expect(formatAge(4 * 60_000)).toBe('4m');
    expect(formatAge(3 * 3_600_000 + 20 * 60_000)).toBe('3h 20m');
    expect(formatAge(2 * 3_600_000)).toBe('2h');
    expect(formatAge(6 * 86_400_000)).toBe('6d');
    expect(formatAge(6 * 86_400_000 + 5 * 3_600_000)).toBe('6d 5h');
  });
});

describe('parseTagIdList', () => {
  it('uppercases, de-duplicates and keeps first-seen order', () => {
    expect(parseTagIdList('3e1e, 441f 3E1E\nD1E')).toEqual({ ids: ['3E1E', '441F', 'D1E'], invalid: [] });
  });

  it('rejects anything longer than a tag id', () => {
    const result = parseTagIdList('3E1E F9000004');
    expect(result.ids).toEqual(['3E1E']);
    expect(result.invalid).toEqual(['F9000004']);
  });

  it('handles empty input', () => {
    expect(parseTagIdList('')).toEqual({ ids: [], invalid: [] });
    expect(parseTagIdList(null)).toEqual({ ids: [], invalid: [] });
  });
});

describe('Johannesburg time helpers', () => {
  it('formats an instant in UTC+2 regardless of the host clock', () => {
    // 21:30 UTC is 23:30 the same day in Johannesburg.
    expect(epochToJhb(Date.parse('2026-08-27T21:30:00Z'))).toEqual({
      date: '27-Aug-2026',
      time: '23:30:00',
      iso: '2026-08-27T23:30:00+02:00',
    });
    // 23:30 UTC has already rolled into the next Johannesburg day.
    expect(epochToJhb(Date.parse('2026-08-27T23:30:00Z')).date).toBe('28-Aug-2026');
  });

  it('renders the logs API date format', () => {
    expect(toApiDate(new Date('2026-08-27T21:30:00Z'))).toBe('2026-08-27T23:30');
  });

  it('finds Johannesburg-local midnight N days back', () => {
    const now = Date.parse('2026-08-28T09:00:00Z');
    expect(epochToJhb(jhbMidnightMsDaysAgo(0, now))).toMatchObject({ date: '28-Aug-2026', time: '00:00:00' });
    expect(epochToJhb(jhbMidnightMsDaysAgo(7, now))).toMatchObject({ date: '21-Aug-2026', time: '00:00:00' });
  });
});

describe('report schedule', () => {
  /** The fleet's real setting: 19 hourly reports from 04:10, read 10 minutes later. */
  const fleet = {
    reportStartMinute: 4 * 60 + 10,
    reportIntervalMinutes: 60,
    reportCountPerDay: 19,
    pollOffsetMinutes: 10,
  };

  it('expands the daily report series, ending at the last report of the day', () => {
    const reports = reportTimesOfDay(fleet).map(formatMinuteOfDay);
    expect(reports).toHaveLength(19);
    expect(reports[0]).toBe('04:10');
    expect(reports[reports.length - 1]).toBe('22:10');
  });

  it('reads each report after the offset', () => {
    const polls = pollTimesOfDay(fleet).map(formatMinuteOfDay);
    expect(polls[0]).toBe('04:20');
    expect(polls[1]).toBe('05:20');
    expect(polls[polls.length - 1]).toBe('22:20');
  });

  it('describes the whole schedule in one line', () => {
    expect(describeSchedule(fleet)).toBe('04:20, 05:20 … 22:20 · 19/day');
    expect(describeSchedule({ ...fleet, reportCountPerDay: 1 })).toBe('04:20 · 1/day');
  });

  it('round-trips a clock time', () => {
    expect(parseMinuteOfDay('04:10')).toBe(250);
    expect(formatMinuteOfDay(250)).toBe('04:10');
    expect(parseMinuteOfDay('24:00')).toBeNull();
    expect(parseMinuteOfDay('nonsense')).toBeNull();
  });
});
