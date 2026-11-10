import { describe, expect, it } from 'vitest';
import {
  allocateTagsToGeofences,
  distanceToGeofenceEdge,
  geofenceCentroid,
  geofenceLabelPoint,
  geofenceTagCounts,
  pointInGeofence,
  type DeviceRow,
  type GeofenceRegion,
  type TagSnapshot,
} from '@tagexplore/core';

const NOW = Date.parse('2026-11-09T10:00:00Z');
const ROUND = NOW - 10 * 60_000;
// ~111 m per 0.001° of latitude; a roughly 220 m square around (-29, 25).
const SQUARE: Array<[number, number]> = [
  [-29.001, 24.999],
  [-29.001, 25.001],
  [-28.999, 25.001],
  [-28.999, 24.999],
];
const fence = (regionId: string, coordinates = SQUARE): GeofenceRegion => ({ regionId, name: regionId, color: null, coordinates });
// A second square ~1.1 km north.
const NORTH = SQUARE.map(([lat, lon]) => [lat + 0.01, lon] as [number, number]);

function snap(partial: Partial<TagSnapshot>): TagSnapshot {
  return {
    tagId: 't1',
    label: null,
    lastSeenAt: ROUND,
    batteryMv: null,
    rssi: null,
    hops: null,
    waveCount: null,
    movementState: null,
    fwVersionPatch: null,
    linkId: null,
    sourceDeviceImei: 'r1',
    lat: null,
    lon: null,
    fixAt: null,
    gpsAgeSeconds: null,
    readingCount: 1,
    stillSince: null,
    ...partial,
  };
}

type Reader = Pick<DeviceRow, 'imei' | 'lat' | 'lon' | 'positionSource' | 'positionAt' | 'gpsUpdatedAt'>;
const reader = (partial: Partial<Reader>): Reader => ({
  imei: 'r1',
  lat: null,
  lon: null,
  positionSource: 'none',
  positionAt: null,
  gpsUpdatedAt: null,
  ...partial,
});

describe('geofence geometry', () => {
  it('tells inside from outside', () => {
    expect(pointInGeofence([-29, 25], SQUARE)).toBe(true);
    expect(pointInGeofence([-29.002, 25], SQUARE)).toBe(false);
  });

  it('measures the distance to the nearest edge in metres', () => {
    // 0.001° south of the bottom edge ≈ 110 m.
    expect(distanceToGeofenceEdge([-29.002, 25], SQUARE)).toBeGreaterThan(105);
    expect(distanceToGeofenceEdge([-29.002, 25], SQUARE)).toBeLessThan(115);
  });

  it('puts the centroid in the middle', () => {
    const [lat, lon] = geofenceCentroid(SQUARE)!;
    expect(lat).toBeCloseTo(-29, 6);
    expect(lon).toBeCloseTo(25, 6);
  });
});

describe('allocateTagsToGeofences', () => {
  const run = (snaps: TagSnapshot[], readers: Reader[], fences = [fence('a'), fence('b', NORTH)]) =>
    allocateTagsToGeofences(snaps, readers, fences, 'latest', NOW);

  it('uses the tag’s own current fix first', () => {
    const r = run(
      [snap({ lat: -29, lon: 25, fixAt: ROUND })],
      [reader({ lat: -28.99, lon: 25, positionSource: 'own', positionAt: ROUND })],
    ).get('t1')!;
    expect(r).toMatchObject({ regionIds: ['a'], reason: 'inside' });
    expect(r.position?.source).toBe('tag-gps');
  });

  it('falls back to the reporting reader when the tag has no current fix', () => {
    const r = run(
      [snap({ lat: -29, lon: 25, fixAt: ROUND - 86_400_000 })],
      [reader({ lat: -28.99, lon: 25, positionSource: 'own', positionAt: ROUND })],
    ).get('t1')!;
    expect(r).toMatchObject({ regionIds: ['b'], reason: 'inside' });
    expect(r.position?.source).toBe('reader');
  });

  it('uses the newest position of either when neither is current', () => {
    const tagNewer = run(
      [snap({ lat: -29, lon: 25, fixAt: ROUND - 3_600_000 })],
      [reader({ lat: -28.99, lon: 25, positionSource: 'stale', positionAt: ROUND - 86_400_000 })],
    ).get('t1')!;
    expect(tagNewer.position?.source).toBe('tag-last-gps');
    expect(tagNewer.regionIds).toEqual(['a']);

    const readerNewer = run(
      [snap({ lat: -29, lon: 25, fixAt: ROUND - 86_400_000 })],
      [reader({ lat: -28.99, lon: 25, positionSource: 'stale', positionAt: ROUND - 3_600_000 })],
    ).get('t1')!;
    expect(readerNewer.position?.source).toBe('reader-last');
    expect(readerNewer.regionIds).toEqual(['b']);
  });

  it('puts a tag within 50 m outside into the nearest geofence', () => {
    // ~22 m south of fence a.
    const r = run([snap({ lat: -29.0012, lon: 25, fixAt: ROUND })], []).get('t1')!;
    expect(r).toMatchObject({ regionIds: ['a'], reason: 'nearest' });
  });

  it('leaves out a tag whose own fix is 50 m or more outside every geofence', () => {
    const r = run([snap({ lat: -29.003, lon: 25, fixAt: ROUND })], []).get('t1')!;
    expect(r).toMatchObject({ regionIds: [], reason: 'outside' });
  });

  it('never leaves out a tag placed by its reader, however far', () => {
    const r = run([snap({})], [reader({ lat: -29.05, lon: 25, positionSource: 'own', positionAt: ROUND })]).get('t1')!;
    expect(r).toMatchObject({ regionIds: ['a'], reason: 'nearest' });
  });

  it('counts only the tags passed as counted', () => {
    const fences = [fence('a'), fence('b', NORTH)];
    const alloc = allocateTagsToGeofences(
      [snap({ tagId: 'x', lat: -29, lon: 25, fixAt: ROUND }), snap({ tagId: 'y', lat: -29, lon: 25, fixAt: ROUND })],
      [],
      fences,
      'latest',
      NOW,
    );
    const counts = geofenceTagCounts(alloc, fences, new Set(['x']));
    expect(counts.get('a')).toBe(1);
    expect(counts.get('b')).toBe(0);
  });

  it('counts a tag inside two overlapping geofences in both', () => {
    // A second square shifted half-way east overlaps fence a.
    const east = SQUARE.map(([lat, lon]) => [lat, lon + 0.001] as [number, number]);
    const fences = [fence('a'), fence('c', east)];
    const alloc = allocateTagsToGeofences([snap({ lat: -29, lon: 25.0005, fixAt: ROUND })], [], fences, 'latest', NOW);
    expect(alloc.get('t1')!.regionIds.sort()).toEqual(['a', 'c']);
    const counts = geofenceTagCounts(alloc, fences, new Set(['t1']));
    expect(counts.get('a')).toBe(1);
    expect(counts.get('c')).toBe(1);
  });
});

describe('geofenceLabelPoint', () => {
  it('keeps the centroid when it is inside', () => {
    const [lat, lon] = geofenceLabelPoint(SQUARE)!;
    expect(lat).toBeCloseTo(-29, 6);
    expect(lon).toBeCloseTo(25, 6);
  });

  it('moves the point inside a C-shaped geofence whose centroid falls outside', () => {
    // A "C" opening east: the centroid lands in the empty notch.
    const C: Array<[number, number]> = [
      [-29.003, 24.997],
      [-29.003, 25.003],
      [-29.002, 25.003],
      [-29.002, 24.998],
      [-28.998, 24.998],
      [-28.998, 25.003],
      [-28.997, 25.003],
      [-28.997, 24.997],
    ];
    expect(pointInGeofence(geofenceCentroid(C)!, C)).toBe(false);
    expect(pointInGeofence(geofenceLabelPoint(C)!, C)).toBe(true);
  });
});
