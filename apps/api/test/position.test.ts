import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, type Config } from '../src/config.js';
import { Store } from '../src/db/index.js';
import { createLiveBus, type LiveEvent } from '../src/events/bus.js';
import { ingestDevice } from '../src/ingest/ingest.js';
import { pollDevicePosition } from '../src/ingest/position.js';

const ORG = 'org-a';
const DEVICE = '866049074634379';
const T0 = Date.parse('2026-07-22T09:00:00+02:00');

/**
 * The events API's own envelope: a paged `{ items: [...] }` whose first item
 * carries the reader's fix and every geofence it knows about.
 */
function stubEventsApi(event: Record<string, unknown> | null): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ items: event ? [event] : [] }), { status: 200 })),
  );
}

let dir: string;
let store: Store;
let config: Config;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tagexplore-position-'));
  store = new Store(join(dir, 'test.db'), 'nobody');
  store.createOrg(ORG, 'Org A');
  store.createDevice(DEVICE, ORG, 'Reader 379');
  // The events API is only called at all when a token is configured.
  config = { ...loadConfig(), settingsApiToken: 'test-token' };
});

afterEach(() => {
  vi.unstubAllGlobals();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('pollDevicePosition', () => {
  it('stores the fix as both the cached position and a history row', () => {
    stubEventsApi({ gpsLatitude: -33.9637, gpsLongitude: 18.8383, timestamp: new Date(T0).toISOString() });

    return pollDevicePosition(store, config, undefined, DEVICE).then((result) => {
      expect(result.positionWritten).toBe(true);
      expect(store.getDevice(DEVICE)).toMatchObject({ lat: -33.9637, lon: 18.8383, gpsUpdatedAt: T0 });
      // The history row is what makes a past round showable with the reader
      // where it actually was, so it has to be written too, not just the cache.
      expect(store.getDevicePositionAt(DEVICE, T0)).toMatchObject({ lat: -33.9637, lon: 18.8383 });
    });
  });

  it('stores the geofences riding the same request', async () => {
    stubEventsApi({
      gpsLatitude: -33.9637,
      gpsLongitude: 18.8383,
      timestamp: new Date(T0).toISOString(),
      regions: [
        {
          id: 4330,
          name: 'Etse',
          colour: '#E9AE2F',
          coordinates: [
            { latitude: -33.9, longitude: 18.8 },
            { latitude: -33.8, longitude: 18.8 },
            { latitude: -33.8, longitude: 18.9 },
          ],
        },
      ],
    });

    const result = await pollDevicePosition(store, config, undefined, DEVICE);
    expect(result.geofencesWritten).toBe(1);
    expect(store.listGeofences(ORG)).toHaveLength(1);
  });

  it('announces both, so every browser watching this org re-reads', async () => {
    stubEventsApi({
      gpsLatitude: -33.9637,
      gpsLongitude: 18.8383,
      timestamp: new Date(T0).toISOString(),
      regions: [
        {
          id: 4330,
          name: 'Etse',
          coordinates: [
            { latitude: -33.9, longitude: 18.8 },
            { latitude: -33.8, longitude: 18.8 },
            { latitude: -33.8, longitude: 18.9 },
          ],
        },
      ],
    });

    const bus = createLiveBus();
    const seen: LiveEvent[] = [];
    bus.subscribe(ORG, (e) => seen.push(e));

    await pollDevicePosition(store, config, bus, DEVICE);

    expect(seen.map((e) => e.type)).toEqual(['device-position', 'geofences']);
  });

  it('leaves the stored position alone when the events API fails, and does not throw', async () => {
    stubEventsApi({ gpsLatitude: -33.9637, gpsLongitude: 18.8383, timestamp: new Date(T0).toISOString() });
    await pollDevicePosition(store, config, undefined, DEVICE);

    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await pollDevicePosition(store, config, undefined, DEVICE);
    expect(result.positionWritten).toBe(false);
    expect(store.getDevice(DEVICE)).toMatchObject({ lat: -33.9637, lon: 18.8383 });
    vi.restoreAllMocks();
  });

  it('treats (0, 0) as no fix rather than as a position in the Atlantic', async () => {
    stubEventsApi({ gpsLatitude: 0, gpsLongitude: 0, timestamp: new Date(T0).toISOString() });
    const result = await pollDevicePosition(store, config, undefined, DEVICE);
    expect(result.positionWritten).toBe(false);
    expect(store.getDevice(DEVICE)).toMatchObject({ lat: null, lon: null });
  });
});

describe('ingestDevice', () => {
  it('no longer reads the events API at all', async () => {
    // The regression guard for the decoupling: a log scrape used to be the
    // only thing that moved the purple marker, which tied the reader's
    // position to the scrape schedule and froze it entirely for a device that
    // only ever pushes.
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(String(url));
        return new Response(JSON.stringify([{ logText: '' }]), { status: 200 });
      }),
    );

    await ingestDevice(store, config, DEVICE, new Date(T0));

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.some((url) => url.includes('/events'))).toBe(false);
    expect(calls.every((url) => url.includes('/logs'))).toBe(true);
  });
});
