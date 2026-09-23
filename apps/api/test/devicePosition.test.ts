import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../src/config.js';
import { Store, type ReadingInput, type RoundInput } from '../src/db/index.js';
import { resolveDevicePosition } from '../src/devices/position.js';

/**
 * The rule under test: a reader's cached GPS fix only describes a discovery if
 * it was reported close enough to it in time. Everything here is about which
 * of the four answers — own fix, carried tag, last known, nothing — the chain
 * lands on, and why.
 */

const ORG = 'org-a';
const DEVICE = '866049074634379';
const CARRIED = '3E1E';
const MINUTE = 60_000;
const BRACKET = Date.parse('2026-07-22T09:00:00+02:00');

let dir: string;
let store: Store;
let config: Config;

function round(patch: Partial<RoundInput> = {}): RoundInput {
  return {
    bracketAt: BRACKET,
    deviceImei: DEVICE,
    tagCount: 1,
    durationSeconds: 60,
    unitBatteryMv: 4000,
    readerFw: 'v2.4.0',
    timedOut: false,
    source: 'log',
    receivedAt: null,
    ...patch,
  };
}

function reading(patch: Partial<ReadingInput> = {}): ReadingInput {
  return {
    bracketAt: BRACKET,
    deviceImei: DEVICE,
    tagId: CARRIED,
    batteryMv: 3600,
    rssi: -58,
    hops: 0,
    waveCount: 1,
    movementState: 1,
    lat: -33.8,
    lon: 18.7,
    hasGps: true,
    fwPatch: 4,
    gpsAgeSeconds: null,
    linkId: null,
    source: 'log',
    ...patch,
  };
}

const resolve = (bracketAt: number | null = BRACKET) => {
  const device = store.getDevice(DEVICE);
  if (!device) throw new Error('no device');
  return resolveDevicePosition(store, config, device, bracketAt);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tagexplore-devpos-'));
  store = new Store(join(dir, 'test.db'), 'nobody');
  store.createOrg(ORG, 'Org A');
  store.createDevice(DEVICE, ORG, 'Reader 379');
  config = { ...loadConfig(), devicePositionWindowMinutes: 10, bracketMinutes: 15, devicePositionBracketSlack: true };
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('resolveDevicePosition', () => {
  it('uses the reader’s own fix when it falls inside the window', () => {
    store.writeReadings([], [round()]);
    store.setDevicePosition(DEVICE, -33.9, 18.8, BRACKET + 4 * MINUTE);

    expect(resolve()).toMatchObject({
      positionSource: 'own',
      lat: -33.9,
      lon: 18.8,
      positionAt: BRACKET + 4 * MINUTE,
      discoveryAt: BRACKET,
    });
  });

  it('greys out a fix from well outside the window, rather than showing it as current', () => {
    store.writeReadings([], [round()]);
    store.setDevicePosition(DEVICE, -33.9, 18.8, BRACKET - 40 * MINUTE);

    expect(resolve()).toMatchObject({
      positionSource: 'stale',
      lat: -33.9,
      positionAt: BRACKET - 40 * MINUTE,
      positionTagId: null,
    });
  });

  it('falls back to the carried tag’s own fix in that same round', () => {
    store.setCarriedTag(DEVICE, CARRIED);
    store.writeReadings([reading()], [round()]);
    store.setDevicePosition(DEVICE, -33.9, 18.8, BRACKET - 40 * MINUTE);

    expect(resolve()).toMatchObject({
      positionSource: 'linked-tag',
      lat: -33.8,
      lon: 18.7,
      positionTagId: CARRIED,
      positionAt: BRACKET,
    });
  });

  it('rejects a carried-tag fix the tag itself says is old', () => {
    // Relaying a stale fix through a tag does not make it fresh, so it is held
    // to the same window the reader's own fix would have been.
    store.setCarriedTag(DEVICE, CARRIED);
    store.writeReadings([reading({ gpsAgeSeconds: 3600 })], [round()]);
    store.setDevicePosition(DEVICE, -33.9, 18.8, BRACKET - 40 * MINUTE);

    expect(resolve()).toMatchObject({ positionSource: 'stale', lat: -33.9 });
  });

  it('does not reach into a neighbouring round for the carried tag', () => {
    // "The tag's position for this discovery" means that discovery. A fix from
    // the round before is an answer to a different question.
    store.setCarriedTag(DEVICE, CARRIED);
    store.writeReadings([reading({ bracketAt: BRACKET - 15 * MINUTE })], [round(), round({ bracketAt: BRACKET - 15 * MINUTE })]);
    store.setDevicePosition(DEVICE, -33.9, 18.8, BRACKET - 40 * MINUTE);

    expect(resolve()).toMatchObject({ positionSource: 'stale' });
  });

  it('reports nothing at all when the reader has never been positioned', () => {
    store.writeReadings([], [round()]);
    expect(resolve()).toMatchObject({ positionSource: 'none', lat: null, lon: null });
  });

  it('widens the window for a scraped round, because its bracket is not an exact time', () => {
    // A scraped round only knows the 15-minute bucket its blocks fell in, so
    // its true time is within ±7.5 minutes of that. A fix 12 minutes off is
    // therefore plausibly within 10 minutes of the round itself.
    store.writeReadings([], [round({ receivedAt: null })]);
    store.setDevicePosition(DEVICE, -33.9, 18.8, BRACKET + 12 * MINUTE);

    expect(resolve()).toMatchObject({ positionSource: 'own' });

    const strict = { ...config, devicePositionBracketSlack: false };
    const device = store.getDevice(DEVICE);
    expect(resolveDevicePosition(store, strict, device!, BRACKET)).toMatchObject({ positionSource: 'stale' });
  });

  it('gives a pushed round no such slack — it knows exactly when it arrived', () => {
    const receivedAt = BRACKET + 2 * MINUTE;
    store.writeReadings([], [round({ source: 'cbor', receivedAt })]);
    store.setDevicePosition(DEVICE, -33.9, 18.8, receivedAt + 12 * MINUTE);

    expect(resolve()).toMatchObject({ positionSource: 'stale', discoveryAt: receivedAt });
  });

  it('judges the live view against the reader’s own latest round, not the wall clock', () => {
    // Otherwise a reader that stopped reporting hours ago would keep showing a
    // green marker simply because its last fix was recent.
    store.writeReadings([], [round()]);
    store.setDevicePosition(DEVICE, -33.9, 18.8, BRACKET + 3 * MINUTE);

    expect(resolve(null)).toMatchObject({ positionSource: 'own', discoveryAt: BRACKET });
  });

  it('leaves a reader that has never reported a round alone', () => {
    store.setDevicePosition(DEVICE, -33.9, 18.8, BRACKET);
    // There is no discovery to judge it against, so it stays at the
    // conservative default rather than being called applicable.
    expect(resolve(null)).toMatchObject({ positionSource: 'stale', discoveryAt: null });
  });
});
