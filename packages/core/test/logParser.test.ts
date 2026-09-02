import { describe, expect, it } from 'vitest';
import { parseLogText } from '@tagexplore/core';
import { fixture } from './helpers.js';

describe('parseLogText — advanced mode', () => {
  const blocks = parseLogText(fixture('advancedMode'), 'UNIT_A');

  it('reads one dated block and its reader firmware version', () => {
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.timestamp).toBe('2026-07-22T09:00:12+02:00');
    expect(blocks[0]?.unitBatteryMv).toBe(4010);
    expect(blocks[0]?.readerFwVersion).toBe('v2.0.1');
    expect(blocks[0]?.total).toBe(4);
  });

  it('maps columns from the header line, not a fixed order', () => {
    const tag = blocks[0]?.tags.find((t) => t.id === '441F');
    expect(tag).toMatchObject({
      hops: 1,
      waveCount: 1,
      rssi: -55,
      battery: 3678,
      movementState: 1,
      fwVersionPatch: 22,
      hasGps: true,
    });
    // Microdegrees in the log, decimal degrees out.
    expect(tag?.lat).toBeCloseTo(-33.963701, 6);
    expect(tag?.lon).toBeCloseTo(18.838046, 6);
  });

  it('treats 0,0 as no fix rather than a position off West Africa', () => {
    const tag = blocks[0]?.tags.find((t) => t.id === '3E1E');
    expect(tag?.hasGps).toBe(false);
    expect(tag?.lat).toBeNull();
    expect(tag?.lon).toBeNull();
  });
});

describe('parseLogText — basic mode', () => {
  const blocks = parseLogText(fixture('basicMode'), 'UNIT_B');

  it('reads the basic field set, including GPS age', () => {
    const tag = blocks[0]?.tags.find((t) => t.id === '3E1E');
    expect(tag).toMatchObject({ battery: 3666, rssi: -40, movementState: 1, fwVersionPatch: 22, gpsAgeSeconds: 115 });
    expect(tag?.lat).toBeCloseTo(-33.96333, 5);
  });

  it('leaves fields the mode does not report as null', () => {
    const tag = blocks[0]?.tags.find((t) => t.id === '3E1E');
    expect(tag?.hops).toBeNull();
    expect(tag?.waveCount).toBeNull();
  });
});

describe('parseLogText — logs predating the header line', () => {
  const blocks = parseLogText(fixture('device379'), '866049074634379');

  it('falls back to the original known column order', () => {
    const first = blocks[0]?.tags.find((t) => t.id === '3194');
    expect(first).toMatchObject({ hops: 1, rssi: -85, battery: 4055, waveCount: 1, movementState: 1, hasGps: false });

    const withGps = blocks[0]?.tags.find((t) => t.id === '121F');
    expect(withGps?.hasGps).toBe(true);
    expect(withGps?.lat).toBeCloseTo(-33.964078, 6);
    expect(withGps?.fwVersionPatch).toBe(12);
  });

  it('flags a LOG TIMEOUT block instead of dropping it', () => {
    expect(blocks).toHaveLength(3);
    expect(blocks[1]?.isTimeout).toBe(true);
    expect(blocks[1]?.tags).toEqual([]);
  });
});

describe('parseLogText — undated discovery anchors (firmware v2.1.x)', () => {
  it('inherits the date from the dated info lines before it', () => {
    const blocks = parseLogText(fixture('bareAnchorV21'), 'UNIT_A');
    expect(blocks).toHaveLength(2);
    expect(blocks[1]?.timestamp).toBe('2026-08-19T09:01:52+02:00');
    expect(blocks[1]?.tags.map((t) => t.id)).toEqual(['3D14', '141F', '441F']);
  });

  it('rolls the date forward when the clock steps back over midnight', () => {
    const blocks = parseLogText(fixture('bareAnchorMidnight'), 'UNIT_A');
    const stamps = blocks.map((b) => b.timestamp);
    expect(stamps).toEqual([
      '2026-08-27T23:00:30+02:00',
      '2026-08-28T00:00:26+02:00',
      '2026-08-28T00:34:03+02:00',
      '2026-08-28T01:00:25+02:00',
    ]);
  });

  it('dates anchors that appear before the first dated line by working backwards', () => {
    const blocks = parseLogText(fixture('bareAnchorBackfill'), 'UNIT_A');
    expect(blocks.map((b) => b.timestamp)).toEqual([
      '2026-08-27T22:00:27+02:00',
      '2026-08-27T23:00:30+02:00',
      '2026-08-28T00:00:26+02:00',
    ]);
  });
});

describe('parseLogText — non-tag rows', () => {
  it('drops the firmware transfer pseudo-devices that use 8-character ids', () => {
    const blocks = parseLogText(fixture('bareAnchorMidnight'), 'UNIT_A');
    const fotaBlock = blocks.find((b) => b.timestamp === '2026-08-28T00:34:03+02:00');
    // The log's own "Total devices discovered: 1" counts F9000004; we do not.
    expect(fotaBlock?.total).toBe(1);
    expect(fotaBlock?.tags).toEqual([]);
  });
});
