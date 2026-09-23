import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GeofenceRegion } from '@tagexplore/core';
import { Store, type ReadingInput, type RoundInput } from '../src/db/index.js';

let dir: string;
let store: Store;

const ORG = 'org-a';
const OTHER_ORG = 'org-b';
const DEVICE = '866049074634379';
const SECOND_DEVICE = '866049074634403';
const OTHER_DEVICE = '866049074634999';

/** 2026-08-28T10:00:00Z, so windows in these tests read the same on any host. */
const T0 = Date.parse('2026-08-28T10:00:00Z');
const HOUR = 3_600_000;

function reading(partial: Partial<ReadingInput> & Pick<ReadingInput, 'bracketAt' | 'tagId'>): ReadingInput {
  return {
    deviceImei: DEVICE,
    batteryMv: 3900,
    rssi: -60,
    hops: 1,
    waveCount: 1,
    movementState: 1,
    lat: null,
    lon: null,
    hasGps: false,
    fwPatch: 3,
    gpsAgeSeconds: null,
    linkId: null,
    source: 'log',
    ...partial,
  };
}

function round(partial: Partial<RoundInput> & Pick<RoundInput, 'bracketAt'>): RoundInput {
  return {
    deviceImei: DEVICE,
    tagCount: 1,
    durationSeconds: null,
    unitBatteryMv: null,
    readerFw: null,
    timedOut: false,
    source: 'log',
    receivedAt: null,
    ...partial,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tagexplore-test-'));
  store = new Store(join(dir, 'test.db'), 'nobody');
  store.createOrg(ORG, 'Org A');
  store.createOrg(OTHER_ORG, 'Org B');
  store.createDevice(DEVICE, ORG, 'Reader 379');
  store.createDevice(SECOND_DEVICE, ORG, 'Reader 403');
  store.createDevice(OTHER_DEVICE, OTHER_ORG, 'Someone else’s reader');
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('readings', () => {
  it('replaces rather than duplicates when a poll re-reads the same bracket', () => {
    store.addOrgTags(ORG, ['3E1E']);
    store.writeReadings([reading({ bracketAt: T0, tagId: '3E1E', batteryMv: 3900 })], []);
    store.writeReadings([reading({ bracketAt: T0, tagId: '3E1E', batteryMv: 3888 })], []);

    const snapshots = store.tagSnapshots({ orgId: ORG, from: T0 - HOUR, to: T0 + HOUR });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.batteryMv).toBe(3888);
    expect(snapshots[0]?.readingCount).toBe(1);
  });

  it('reports the newest reading but the newest *fix*, which is often older', () => {
    store.addOrgTags(ORG, ['3E1E']);
    store.writeReadings(
      [
        reading({ bracketAt: T0 - 2 * HOUR, tagId: '3E1E', lat: -33.9633, lon: 18.8383, hasGps: true, gpsAgeSeconds: 115 }),
        reading({ bracketAt: T0, tagId: '3E1E', batteryMv: 3850, hasGps: false }),
      ],
      [],
    );

    const [snapshot] = store.tagSnapshots({ orgId: ORG, from: T0 - 24 * HOUR, to: T0 });
    expect(snapshot?.lastSeenAt).toBe(T0);
    expect(snapshot?.batteryMv).toBe(3850);
    expect(snapshot?.fixAt).toBe(T0 - 2 * HOUR);
    expect(snapshot?.lat).toBeCloseTo(-33.9633, 4);
    expect(snapshot?.gpsAgeSeconds).toBe(115);
  });

  it('carries the link id through to the snapshot, and reports none when there was no link', () => {
    store.addOrgTags(ORG, ['3E1E', '441F']);
    store.writeReadings(
      [
        reading({ bracketAt: T0, tagId: '3E1E', linkId: 'E20' }),
        reading({ bracketAt: T0, tagId: '441F', linkId: null }),
      ],
      [],
    );

    const snapshots = store.tagSnapshots({ orgId: ORG, from: T0 - HOUR, to: T0 + HOUR });
    expect(snapshots.find((s) => s.tagId === '3E1E')?.linkId).toBe('E20');
    expect(snapshots.find((s) => s.tagId === '441F')?.linkId).toBeNull();
  });

  it('counts a round once even when two of the org’s devices heard the same tag', () => {
    store.addOrgTags(ORG, ['3E1E']);
    store.writeReadings(
      [
        reading({ bracketAt: T0, tagId: '3E1E', deviceImei: DEVICE, rssi: -60 }),
        reading({ bracketAt: T0, tagId: '3E1E', deviceImei: SECOND_DEVICE, rssi: -80 }),
      ],
      [],
    );

    const [snapshot] = store.tagSnapshots({ orgId: ORG, from: T0 - HOUR, to: T0 + HOUR });
    expect(snapshot?.readingCount).toBe(1);
    expect([DEVICE, SECOND_DEVICE]).toContain(snapshot?.sourceDeviceImei);
  });

  it('hides tags that are not on the organisation’s whitelist', () => {
    store.addOrgTags(ORG, ['3E1E']);
    store.writeReadings(
      [reading({ bracketAt: T0, tagId: '3E1E' }), reading({ bracketAt: T0, tagId: '441F' })],
      [],
    );

    const snapshots = store.tagSnapshots({ orgId: ORG, from: T0 - HOUR, to: T0 + HOUR });
    expect(snapshots.map((s) => s.tagId)).toEqual(['3E1E']);
  });

  it('does not leak another organisation’s readings, even for the same tag id', () => {
    store.addOrgTags(ORG, ['3E1E']);
    store.addOrgTags(OTHER_ORG, ['3E1E']);
    store.writeReadings([reading({ bracketAt: T0, tagId: '3E1E', deviceImei: OTHER_DEVICE, batteryMv: 3111 })], []);

    expect(store.tagSnapshots({ orgId: ORG, from: T0 - HOUR, to: T0 + HOUR })).toEqual([]);
    expect(store.tagSnapshots({ orgId: OTHER_ORG, from: T0 - HOUR, to: T0 + HOUR })[0]?.batteryMv).toBe(3111);
  });

  it('respects the window', () => {
    store.addOrgTags(ORG, ['3E1E']);
    store.writeReadings([reading({ bracketAt: T0 - 100 * HOUR, tagId: '3E1E' })], []);
    expect(store.tagSnapshots({ orgId: ORG, from: T0 - 24 * HOUR, to: T0 })).toEqual([]);
    expect(store.tagSnapshots({ orgId: ORG, from: T0 - 200 * HOUR, to: T0 })).toHaveLength(1);
  });
});

describe('batterySeries', () => {
  beforeEach(() => {
    store.addOrgTags(ORG, ['3E1E', '441F']);
    store.writeReadings(
      [
        reading({ bracketAt: T0 - 2 * HOUR, tagId: '3E1E', batteryMv: 3900 }),
        reading({ bracketAt: T0 - HOUR, tagId: '3E1E', batteryMv: 3880 }),
        reading({ bracketAt: T0, tagId: '3E1E', batteryMv: 3860 }),
        reading({ bracketAt: T0, tagId: '441F', batteryMv: 3700 }),
      ],
      [],
    );
  });

  it('returns one series per requested tag, oldest point first', () => {
    const series = store.batterySeries({ orgId: ORG, from: T0 - 24 * HOUR, to: T0 }, ['3E1E'], 15);
    expect(series).toHaveLength(1);
    expect(series[0]?.tagId).toBe('3E1E');
    expect(series[0]?.points.map((p) => p.mv)).toEqual([3900, 3880, 3860]);
  });

  it('averages into buckets when the range is wide', () => {
    // A 6-hour bucket swallows all three of 3E1E's readings: (3900+3880+3860)/3.
    const series = store.batterySeries({ orgId: ORG, from: T0 - 24 * HOUR, to: T0 }, ['3E1E'], 6 * 60);
    expect(series[0]?.points).toHaveLength(1);
    expect(series[0]?.points[0]?.mv).toBe(3880);
  });

  it('ignores tags that are not whitelisted, even if asked for by id', () => {
    store.writeReadings([reading({ bracketAt: T0, tagId: '9999', batteryMv: 3500 })], []);
    expect(store.batterySeries({ orgId: ORG, from: T0 - HOUR, to: T0 + HOUR }, ['9999'], 15)).toEqual([]);
  });

  it('carries the tag label through, so the chart legend does not need a second call', () => {
    store.setOrgTagLabel(ORG, '3E1E', 'Ewe 12');
    const series = store.batterySeries({ orgId: ORG, from: T0 - 24 * HOUR, to: T0 }, ['3E1E'], 15);
    expect(series[0]?.label).toBe('Ewe 12');
  });
});

describe('tag whitelist', () => {
  it('is idempotent and reports how many were actually new', () => {
    expect(store.addOrgTags(ORG, ['3E1E', '441F'])).toBe(2);
    expect(store.addOrgTags(ORG, ['3E1E', 'D1E'])).toBe(1);
    expect(store.listOrgTags(ORG).map((t) => t.tagId)).toEqual(['3E1E', '441F', 'D1E']);
  });

  it('reports when each whitelisted tag was last heard', () => {
    store.addOrgTags(ORG, ['3E1E', '441F']);
    store.writeReadings([reading({ bracketAt: T0, tagId: '3E1E' })], []);

    const tags = store.listOrgTags(ORG);
    expect(tags.find((t) => t.tagId === '3E1E')?.lastSeenAt).toBe(T0);
    expect(tags.find((t) => t.tagId === '441F')?.lastSeenAt).toBeNull();
  });

  it('keeps the readings when a tag is removed from the whitelist', () => {
    store.addOrgTags(ORG, ['3E1E']);
    store.writeReadings([reading({ bracketAt: T0, tagId: '3E1E' })], []);
    store.removeOrgTag(ORG, '3E1E');

    expect(store.tagSnapshots({ orgId: ORG, from: T0 - HOUR, to: T0 + HOUR })).toEqual([]);
    store.addOrgTags(ORG, ['3E1E']);
    expect(store.tagSnapshots({ orgId: ORG, from: T0 - HOUR, to: T0 + HOUR })).toHaveLength(1);
  });

  it('lists heard-but-unclaimed tags for the admin queue', () => {
    store.addOrgTags(ORG, ['3E1E']);
    store.writeReadings(
      [reading({ bracketAt: T0, tagId: '3E1E' }), reading({ bracketAt: T0, tagId: '441F' })],
      [],
    );

    const unclaimed = store.listUnclaimedTags(T0 - HOUR);
    expect(unclaimed.map((t) => t.tagId)).toEqual(['441F']);
    expect(unclaimed[0]?.orgId).toBe(ORG);
  });
});

describe('devices', () => {
  it('scopes a listing to one organisation', () => {
    expect(store.listDevices(ORG).map((d) => d.imei).sort()).toEqual([SECOND_DEVICE, DEVICE].sort());
    expect(store.listDevices(OTHER_ORG).map((d) => d.imei)).toEqual([OTHER_DEVICE]);
  });

  it('starts on the fleet default: 19 hourly reports from 04:10, read at :20', () => {
    const device = store.getDevice(DEVICE);
    expect(device).toMatchObject({
      reportStartMinute: 250,
      reportIntervalMinutes: 60,
      reportCountPerDay: 19,
      pollOffsetMinutes: 10,
      active: true,
    });
  });

  it('takes a schedule update from the settings API', () => {
    store.updateDevice(DEVICE, { reportStartMinute: 395, reportIntervalMinutes: 30, reportCountPerDay: 24 });
    expect(store.getDevice(DEVICE)).toMatchObject({
      reportStartMinute: 395,
      reportIntervalMinutes: 30,
      reportCountPerDay: 24,
    });
  });

  it('takes deletion down to the readings', () => {
    store.addOrgTags(ORG, ['3E1E']);
    store.writeReadings([reading({ bracketAt: T0, tagId: '3E1E' })], []);
    store.deleteDevice(DEVICE);
    expect(store.tagSnapshots({ orgId: ORG, from: T0 - HOUR, to: T0 + HOUR })).toEqual([]);
  });

  it('remembers where a device’s ingest got to', () => {
    store.writeReadings([reading({ bracketAt: T0, tagId: '3E1E' })], []);
    expect(store.latestBracketFor(DEVICE)).toBe(T0);
    expect(store.latestBracketFor(SECOND_DEVICE)).toBeNull();
  });

  it('has no radio id or position until they are set by hand and by ingest, respectively', () => {
    expect(store.getDevice(DEVICE)).toMatchObject({
      radioId: null,
      radioIdSource: null,
      lat: null,
      lon: null,
      gpsUpdatedAt: null,
    });

    // Through `setRadioId`, not `updateDevice`: the value and the column that
    // records where it came from have to move together, so the generic patch
    // deliberately no longer accepts it.
    store.setRadioId(DEVICE, 'E20');
    store.setDevicePosition(DEVICE, -33.9637, 18.8383, T0);

    expect(store.getDevice(DEVICE)).toMatchObject({
      radioId: 'E20',
      radioIdSource: 'manual',
      lat: -33.9637,
      lon: 18.8383,
      gpsUpdatedAt: T0,
    });
  });

  it('never lets the inference write over a value an admin typed', () => {
    store.setRadioId(DEVICE, 'E20');
    store.setCarriedTag(DEVICE, '3E1E');

    store.applyInferredRadioId(DEVICE, 'FFFF');
    store.applyInferredCarriedTag(DEVICE, 'AAAA');

    expect(store.getDevice(DEVICE)).toMatchObject({
      radioId: 'E20',
      radioIdSource: 'manual',
      carriedTagId: '3E1E',
      carriedTagSource: 'manual',
    });
  });

  it('fills an unset value in, and revises its own earlier guess', () => {
    store.applyInferredRadioId(DEVICE, 'E20');
    expect(store.getDevice(DEVICE)).toMatchObject({ radioId: 'E20', radioIdSource: 'auto' });

    store.applyInferredRadioId(DEVICE, 'E21');
    expect(store.getDevice(DEVICE)).toMatchObject({ radioId: 'E21', radioIdSource: 'auto' });
  });

  it('hands a field back to the inference when it is cleared', () => {
    store.setCarriedTag(DEVICE, '3E1E');
    store.applyInferredCarriedTag(DEVICE, 'AAAA');
    expect(store.getDevice(DEVICE)?.carriedTagId).toBe('3E1E');

    store.setCarriedTag(DEVICE, null);
    expect(store.getDevice(DEVICE)).toMatchObject({ carriedTagId: null, carriedTagSource: null });

    store.applyInferredCarriedTag(DEVICE, 'AAAA');
    expect(store.getDevice(DEVICE)).toMatchObject({ carriedTagId: 'AAAA', carriedTagSource: 'auto' });
  });

  it('finds the position nearest a discovery, not merely the newest before it', () => {
    // Eight minutes early and three minutes late. The later one is closer to
    // the round, which is what "where was it during that discovery" asks.
    store.setDevicePosition(DEVICE, -33.9, 18.8, T0 - 8 * 60_000);
    store.setDevicePosition(DEVICE, -33.8, 18.7, T0 + 3 * 60_000);

    expect(store.getDevicePositionNear(DEVICE, T0, 10 * 60_000)).toMatchObject({ lat: -33.8, lon: 18.7 });
    // `getDevicePositionAt` answers the other question — last known — and must
    // keep doing so, since it is the chain's greyed-out fallback.
    expect(store.getDevicePositionAt(DEVICE, T0)).toMatchObject({ lat: -33.9, lon: 18.8 });
  });

  it('reports no applicable position when every fix is outside the window', () => {
    store.setDevicePosition(DEVICE, -33.9, 18.8, T0 - 40 * 60_000);
    expect(store.getDevicePositionNear(DEVICE, T0, 10 * 60_000)).toBeNull();
    expect(store.getDevicePositionAt(DEVICE, T0)).not.toBeNull();
  });
});

describe('geofences', () => {
  const region = (partial: Partial<GeofenceRegion> = {}): GeofenceRegion => ({
    regionId: '4330',
    name: 'Etse',
    color: '#E9AE2F',
    coordinates: [
      [-33.9633, 18.8383],
      [-33.9635, 18.8385],
      [-33.9631, 18.8387],
    ],
    ...partial,
  });

  it('stores and lists a region, scoped to its organisation', () => {
    store.upsertGeofences(ORG, [region()]);
    store.upsertGeofences(OTHER_ORG, [region({ regionId: '9999', name: 'Wynandsfontein' })]);

    expect(store.listGeofences(ORG)).toEqual([region()]);
    expect(store.listGeofences(OTHER_ORG)).toEqual([region({ regionId: '9999', name: 'Wynandsfontein' })]);
  });

  it('replaces rather than duplicates when the same region id re-ingests', () => {
    store.upsertGeofences(ORG, [region()]);
    store.upsertGeofences(ORG, [region({ name: 'Etse (renamed)', color: '#4FBF8B' })]);

    const fences = store.listGeofences(ORG);
    expect(fences).toHaveLength(1);
    expect(fences[0]).toMatchObject({ name: 'Etse (renamed)', color: '#4FBF8B' });
  });

  it('returns nothing for an organisation with no geofences', () => {
    expect(store.listGeofences(ORG)).toEqual([]);
  });
});

describe('gpsPoints', () => {
  it('returns one point per GPS-carrying reading, not one per tag', () => {
    store.addOrgTags(ORG, ['3E1E']);
    store.writeReadings(
      [
        reading({ bracketAt: T0 - 2 * HOUR, tagId: '3E1E', lat: -33.96, lon: 18.83, hasGps: true }),
        reading({ bracketAt: T0 - HOUR, tagId: '3E1E', lat: -33.961, lon: 18.831, hasGps: true }),
        reading({ bracketAt: T0, tagId: '3E1E', hasGps: false }),
      ],
      [],
    );

    const points = store.gpsPoints({ orgId: ORG, from: T0 - 24 * HOUR, to: T0 });
    expect(points).toHaveLength(2);
  });

  it('excludes tags not on the whitelist and readings from another organisation', () => {
    store.addOrgTags(ORG, ['3E1E']);
    store.writeReadings(
      [
        reading({ bracketAt: T0, tagId: '3E1E', lat: -33.96, lon: 18.83, hasGps: true }),
        reading({ bracketAt: T0, tagId: '441F', lat: -33.97, lon: 18.84, hasGps: true }),
        reading({ bracketAt: T0, tagId: '3E1E', deviceImei: OTHER_DEVICE, lat: -1, lon: -1, hasGps: true }),
      ],
      [],
    );

    const points = store.gpsPoints({ orgId: ORG, from: T0 - HOUR, to: T0 + HOUR });
    expect(points).toEqual([{ lat: -33.96, lon: 18.83 }]);
  });
});

describe('listDiscoveryCounts', () => {
  it('counts distinct tags per bracket, deduped across the org’s devices', () => {
    store.addOrgTags(ORG, ['3E1E', '441F']);
    store.writeReadings(
      [
        // Round 1: two devices both heard 3E1E — one tag, not two.
        reading({ bracketAt: T0 - HOUR, tagId: '3E1E', deviceImei: DEVICE }),
        reading({ bracketAt: T0 - HOUR, tagId: '3E1E', deviceImei: SECOND_DEVICE }),
        // Round 2: both tags.
        reading({ bracketAt: T0, tagId: '3E1E' }),
        reading({ bracketAt: T0, tagId: '441F' }),
      ],
      [],
    );

    const counts = store.listDiscoveryCounts(ORG);
    expect(counts).toEqual([
      { bracketAt: T0, count: 2, durationSeconds: null, receivedAt: null, source: 'log' },
      { bracketAt: T0 - HOUR, count: 1, durationSeconds: null, receivedAt: null, source: 'log' },
    ]);
  });

  it('reports the slowest device’s round duration for the bracket, from rounds not readings', () => {
    store.addOrgTags(ORG, ['3E1E']);
    store.writeReadings(
      [
        reading({ bracketAt: T0, tagId: '3E1E', deviceImei: DEVICE }),
        reading({ bracketAt: T0, tagId: '3E1E', deviceImei: SECOND_DEVICE }),
      ],
      [
        // 14:16:26 landing for a 14:15:00 bracket — 1m26s.
        round({ bracketAt: T0, deviceImei: DEVICE, durationSeconds: 86 }),
        // The other device was faster — only the slowest is reported.
        round({ bracketAt: T0, deviceImei: SECOND_DEVICE, durationSeconds: 12 }),
      ],
    );

    expect(store.listDiscoveryCounts(ORG)).toEqual([
      { bracketAt: T0, count: 1, durationSeconds: 86, receivedAt: null, source: 'log' },
    ]);
  });

  it('drops an excluded device’s round from the duration the same way it drops its readings', () => {
    store.addOrgTags(ORG, ['3E1E']);
    store.writeReadings(
      [
        reading({ bracketAt: T0, tagId: '3E1E', deviceImei: DEVICE }),
        reading({ bracketAt: T0, tagId: '3E1E', deviceImei: SECOND_DEVICE }),
      ],
      [
        round({ bracketAt: T0, deviceImei: DEVICE, durationSeconds: 86 }),
        round({ bracketAt: T0, deviceImei: SECOND_DEVICE, durationSeconds: 12 }),
      ],
    );

    expect(store.listDiscoveryCounts(ORG, 200, [DEVICE])).toEqual([
      { bracketAt: T0, count: 1, durationSeconds: 12, receivedAt: null, source: 'log' },
    ]);
  });

  it('ignores tags not on the whitelist and rounds from another organisation', () => {
    store.addOrgTags(ORG, ['3E1E']);
    store.addOrgTags(OTHER_ORG, ['3E1E']);
    store.writeReadings(
      [
        reading({ bracketAt: T0, tagId: '3E1E' }),
        reading({ bracketAt: T0, tagId: '441F' }), // not whitelisted
        reading({ bracketAt: T0, tagId: '3E1E', deviceImei: OTHER_DEVICE }), // other org
      ],
      [],
    );

    expect(store.listDiscoveryCounts(ORG)).toEqual([
      { bracketAt: T0, count: 1, durationSeconds: null, receivedAt: null, source: 'log' },
    ]);
  });

  it('reports a pushed round by the moment it arrived, and its firmware-measured duration', () => {
    store.addOrgTags(ORG, ['3E1E']);
    const arrived = T0 + 37_000;
    store.writeReadings(
      [reading({ bracketAt: T0, tagId: '3E1E' })],
      [round({ bracketAt: T0, durationSeconds: 52, source: 'cbor', receivedAt: arrived })],
    );

    expect(store.listDiscoveryCounts(ORG)).toEqual([
      { bracketAt: T0, count: 1, durationSeconds: 52, receivedAt: arrived, source: 'cbor' },
    ]);
  });

  it('prefers the pushed round over a scraped one in the same bracket', () => {
    store.addOrgTags(ORG, ['3E1E']);
    const arrived = T0 + 37_000;
    store.writeReadings(
      [
        reading({ bracketAt: T0, tagId: '3E1E', deviceImei: DEVICE }),
        reading({ bracketAt: T0, tagId: '3E1E', deviceImei: SECOND_DEVICE }),
      ],
      [
        // The scraped reader is the slower of the two, so under the old
        // "slowest device wins" rule its 86s would have been reported.
        round({ bracketAt: T0, deviceImei: DEVICE, durationSeconds: 86 }),
        round({ bracketAt: T0, deviceImei: SECOND_DEVICE, durationSeconds: 52, source: 'cbor', receivedAt: arrived }),
      ],
    );

    expect(store.listDiscoveryCounts(ORG)).toEqual([
      { bracketAt: T0, count: 1, durationSeconds: 52, receivedAt: arrived, source: 'cbor' },
    ]);
  });

  it('respects the limit, newest first', () => {
    store.addOrgTags(ORG, ['3E1E']);
    store.writeReadings(
      [
        reading({ bracketAt: T0 - 2 * HOUR, tagId: '3E1E' }),
        reading({ bracketAt: T0 - HOUR, tagId: '3E1E' }),
        reading({ bracketAt: T0, tagId: '3E1E' }),
      ],
      [],
    );

    expect(store.listDiscoveryCounts(ORG, 2).map((c) => c.bracketAt)).toEqual([T0, T0 - HOUR]);
  });
});

describe('discoveryDetail', () => {
  it('returns each reader\u2019s round and every raw reading, uncollapsed and unfiltered', () => {
    store.addOrgTags(ORG, ['3E1E']);
    const arrived = T0 + 37_000;
    store.writeReadings(
      [
        reading({ bracketAt: T0, tagId: '3E1E', deviceImei: DEVICE }),
        reading({ bracketAt: T0, tagId: '3E1E', deviceImei: SECOND_DEVICE, source: 'cbor' }),
        // Not on the whitelist, and still shown: "why is this tag missing" is
        // one of the questions the raw view exists to answer.
        reading({ bracketAt: T0, tagId: '441F', deviceImei: DEVICE }),
        reading({ bracketAt: T0 - HOUR, tagId: '3E1E', deviceImei: DEVICE }),
      ],
      [
        round({ bracketAt: T0, deviceImei: DEVICE, durationSeconds: 86 }),
        round({ bracketAt: T0, deviceImei: SECOND_DEVICE, durationSeconds: 52, source: 'cbor', receivedAt: arrived }),
      ],
    );

    const detail = store.discoveryDetail(ORG, T0);
    expect(detail.bracketAt).toBe(T0);
    expect(detail.rounds.map((r) => [r.deviceImei, r.source, r.receivedAt])).toEqual([
      [DEVICE, 'log', null],
      [SECOND_DEVICE, 'cbor', arrived],
    ]);
    // Both readers' rows for '3E1E' survive, and the other bracket's does not.
    expect(detail.readings.map((r) => [r.tagId, r.deviceImei])).toEqual([
      ['3E1E', DEVICE],
      ['3E1E', SECOND_DEVICE],
      ['441F', DEVICE],
    ]);
  });

  it('orders readings by wave count, then hop count, with the unmeasured ones last', () => {
    store.writeReadings(
      [
        reading({ bracketAt: T0, tagId: 'AAA1', waveCount: 2, hops: 1 }),
        reading({ bracketAt: T0, tagId: 'AAA2', waveCount: 1, hops: 3 }),
        // Basic-mode readings report neither, so they sort to the bottom rather
        // than to the top as SQLite would otherwise put their nulls.
        reading({ bracketAt: T0, tagId: 'AAA3', waveCount: null, hops: null }),
        reading({ bracketAt: T0, tagId: 'AAA4', waveCount: 1, hops: 1 }),
        reading({ bracketAt: T0, tagId: 'AAA5', waveCount: 2, hops: null }),
      ],
      [],
    );

    expect(store.discoveryDetail(ORG, T0).readings.map((r) => r.tagId)).toEqual([
      'AAA4', // 1 / 1
      'AAA2', // 1 / 3
      'AAA1', // 2 / 1
      'AAA5', // 2 / no hop count
      'AAA3', // neither
    ]);
  });

  it('drops an excluded device the same way the count list does', () => {
    store.addOrgTags(ORG, ['3E1E']);
    store.writeReadings(
      [
        reading({ bracketAt: T0, tagId: '3E1E', deviceImei: DEVICE }),
        reading({ bracketAt: T0, tagId: '3E1E', deviceImei: SECOND_DEVICE }),
      ],
      [round({ bracketAt: T0, deviceImei: DEVICE }), round({ bracketAt: T0, deviceImei: SECOND_DEVICE })],
    );

    const detail = store.discoveryDetail(ORG, T0, [DEVICE]);
    expect(detail.rounds.map((r) => r.deviceImei)).toEqual([SECOND_DEVICE]);
    expect(detail.readings.map((r) => r.deviceImei)).toEqual([SECOND_DEVICE]);
  });

  it('never reaches into another organisation\u2019s round', () => {
    store.addOrgTags(OTHER_ORG, ['3E1E']);
    store.writeReadings([reading({ bracketAt: T0, tagId: '3E1E', deviceImei: OTHER_DEVICE })], []);

    expect(store.discoveryDetail(ORG, T0)).toEqual({ bracketAt: T0, rounds: [], readings: [] });
  });
});
