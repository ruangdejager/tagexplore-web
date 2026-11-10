import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { snapshotsAt, type SnapshotHistory, type TagSnapshot } from '@tagexplore/core';
import { Store, type ReadingInput } from '../src/db/index.js';

const ORG = 'org-a';
const R1 = '866049074634379';
const R2 = '866049074634403';
const HOUR = 3_600_000;
const T0 = Date.parse('2026-11-01T00:00:00Z');

let dir: string;
let store: Store;

function reading(tagId: string, bracketAt: number, opts: Partial<ReadingInput> = {}): ReadingInput {
  return {
    deviceImei: R1,
    bracketAt,
    tagId,
    batteryMv: 3900,
    rssi: -60,
    hops: 1,
    waveCount: 1,
    movementState: 0,
    lat: null,
    lon: null,
    hasGps: false,
    fwPatch: 3,
    gpsAgeSeconds: null,
    linkId: null,
    source: 'log',
    ...opts,
  };
}

/** Everything the map draws from, leaving out `readingCount` (documented to differ). */
const drawn = (s: TagSnapshot[]) => s.map(({ readingCount: _ignored, ...rest }) => rest);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tagexplore-history-'));
  store = new Store(join(dir, 'test.db'), 'nobody');
  store.createOrg(ORG, 'Farm A');
  store.createDevice(R1, ORG, 'One');
  store.createDevice(R2, ORG, 'Two');
  store.addOrgTags(ORG, ['AAAA', 'BBBB', 'CCCC']);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('snapshotsAt', () => {
  it('rolls readings forward to the same snapshots and links the server gives for each round', () => {
    const readings: ReadingInput[] = [];
    // Before the window: AAAA has a fix and is moving, BBBB is still.
    readings.push(reading('AAAA', T0, { lat: -29, lon: 25, hasGps: true, gpsAgeSeconds: 20 }));
    readings.push(reading('BBBB', T0, { movementState: 1 }));
    // Inside the window, hourly for a day.
    for (let h = 1; h <= 24; h++) {
      const at = T0 + 72 * HOUR + h * HOUR;
      readings.push(reading('AAAA', at, { movementState: h > 10 ? 1 : 0, hasGps: h % 5 === 0, lat: -29 + h / 1000, lon: 25, linkId: h % 3 === 0 ? 'BBBB' : null }));
      if (h % 2 === 0) readings.push(reading('BBBB', at, { movementState: h > 12 ? 0 : 1, deviceImei: R2 }));
      if (h >= 6) readings.push(reading('CCCC', at, { movementState: 1, hasGps: h === 8, lat: -28.9, lon: 25.1, waveCount: h }));
    }
    store.writeReadings(readings, []);

    const from = T0 + 72 * HOUR;
    const to = T0 + 100 * HOUR;
    const history: SnapshotHistory = {
      from,
      to,
      base: store.tagSnapshots({ orgId: ORG, from: from - 364 * 86_400_000, to: from }),
      readings: store.historyReadings({ orgId: ORG, from, to }),
      labels: {},
    };

    for (let h = 1; h <= 24; h++) {
      const at = from + h * HOUR;
      const server = {
        snapshots: store.tagSnapshots({ orgId: ORG, from: at - 364 * 86_400_000, to: at }),
        links: store.linkReadings({ orgId: ORG, from: at - 364 * 86_400_000, to: at }),
      };
      const local = snapshotsAt(history, at);
      expect(drawn(local.snapshots), `round ${h}`).toEqual(drawn(server.snapshots));
      const key = (l: { tagId: string; sourceDeviceImei: string }) => `${l.tagId}|${l.sourceDeviceImei}`;
      expect([...local.links].sort((a, b) => key(a).localeCompare(key(b))), `links ${h}`).toEqual(
        [...server.links].sort((a, b) => key(a).localeCompare(key(b))),
      );
    }
  });
});
