import { describe, expect, it } from 'vitest';
import { mergeSessions, parseLogText, type DiscoverySession } from '@tagexplore/core';
import { fixture } from './helpers.js';

function good(sessions: ReturnType<typeof mergeSessions>): DiscoverySession[] {
  return sessions.filter((s): s is DiscoverySession => !s.discarded);
}

describe('mergeSessions', () => {
  it('prefers a successful retry over the timed-out block in the same bracket', () => {
    const sessions = mergeSessions({
      UNIT_A: parseLogText(fixture('retryTimeoutA'), 'UNIT_A'),
      UNIT_B: parseLogText(fixture('retryTimeoutB'), 'UNIT_B'),
    });

    expect(sessions).toHaveLength(1);
    const session = sessions[0] as DiscoverySession;
    expect(session.discarded).toBe(false);
    expect(session.timestamp).toBe('2026-07-29T20:00:00+02:00');
    // A saw 18 unique tags, B saw 12 — all of B's are also in A's list.
    expect(session.perDeviceTotals).toEqual({ UNIT_A: 18, UNIT_B: 12 });
    expect(session.total).toBe(18);
    expect(session.involvedUnitIds.sort()).toEqual(['UNIT_A', 'UNIT_B']);
  });

  it('reports the slowest device’s time from the bracket boundary', () => {
    const sessions = mergeSessions({
      UNIT_A: parseLogText(fixture('retryTimeoutA'), 'UNIT_A'),
      UNIT_B: parseLogText(fixture('retryTimeoutB'), 'UNIT_B'),
    });
    // Both devices' successful blocks land at 20:00:40, 40s past the boundary.
    expect((sessions[0] as DiscoverySession).durationSeconds).toBe(40);
  });

  it('discards a bracket where every device timed out', () => {
    const sessions = mergeSessions({
      UNIT_A: parseLogText(fixture('fullTimeoutA'), 'UNIT_A'),
      UNIT_B: parseLogText(fixture('fullTimeoutB'), 'UNIT_B'),
    });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.discarded).toBe(true);
  });

  it('merges two devices in different log modes into one round', () => {
    const sessions = good(
      mergeSessions({
        UNIT_ADVANCED: parseLogText(fixture('advancedMode'), 'UNIT_ADVANCED'),
        UNIT_BASIC: parseLogText(fixture('basicMode'), 'UNIT_BASIC'),
      }),
    );

    expect(sessions).toHaveLength(1);
    const session = sessions[0] as DiscoverySession;
    // 09:00:12 and 09:01:47 both round to the 09:00 bracket.
    expect(session.timestamp).toBe('2026-07-22T09:00:00+02:00');
    expect(session.total).toBe(4);
    expect(session.perDeviceTotals).toEqual({ UNIT_ADVANCED: 4, UNIT_BASIC: 2 });
    expect(session.perDeviceFwVersion).toEqual({ UNIT_ADVANCED: 'v2.0.1' });
  });

  it('backfills GPS onto a tag whose first-seen device reported none', () => {
    const sessions = good(
      mergeSessions({
        UNIT_ADVANCED: parseLogText(fixture('advancedMode'), 'UNIT_ADVANCED'),
        UNIT_BASIC: parseLogText(fixture('basicMode'), 'UNIT_BASIC'),
      }),
    );

    // 3E1E is seen first by the advanced device with 0,0, then by the basic
    // device with a real fix — the position belongs to the tag, so it carries over.
    const tag = (sessions[0] as DiscoverySession).tags.find((t) => t.id === '3E1E');
    expect(tag?.sourceUnitId).toBe('UNIT_ADVANCED');
    expect(tag?.battery).toBe(3637); // the first-seen device's own scan reading
    expect(tag?.hasGps).toBe(true);
    expect(tag?.lat).toBeCloseTo(-33.96333, 5);
    expect(tag?.gpsAgeSeconds).toBe(115);
  });
});
