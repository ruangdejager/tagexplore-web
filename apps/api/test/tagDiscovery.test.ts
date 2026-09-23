import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, type Config } from '../src/config.js';
import { Store, type RoundInput } from '../src/db/index.js';
import { createLiveBus, type LiveEvent } from '../src/events/bus.js';
import { bracketForSession, decodeTagDiscovery, formatPrimaryVersion, storeTagDiscovery } from '../src/ingest/tagDiscovery.js';
import { createTagDiscoveryApi } from '../src/routes/tagDiscovery.js';

/**
 * The three fixtures below were generated from the firmware's own encoder
 * rules — narrowest integer encoding, definite lengths, negative integers as
 * CBOR major type 1 — so they are exact, byte for byte, and are the closest
 * thing to hardware this suite gets.
 */
const ADVANCED_TWO_RECORDS =
  'A5011A00A1B2C302194FB0031A6AA1F940040005828B19ABCD01023856190FAC013A017F5A7F1A01B237550819B2C3018B19123402033865190F32000000070000';
const EMPTY_CAMPAIGN = 'A5011A00A1B2C302194FB0031A6AA1F94004000580';
const BASIC_ONE_RECORD = 'A5011A00A1B2C302194FB0031A6AA1F9400401058189193E1E190E35384301163A017F5A7F1A01B2375519015901';

const PRIMARY_DEVICE_ID = 0x00a1b2c3;
const SESSION_UTC = 1_789_000_000;
/** Just after the fixtures' own session clock, so they pass the RTC sanity check. */
const NOW_MS = SESSION_UTC * 1000 + 30_000;

const IMEI = '866049074634379';
const UNKNOWN_IMEI = '866049074634999';
const ORG = 'org-a';

function bytes(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

let dir: string;
let store: Store;
let config: Config;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tagexplore-tagdiscovery-'));
  store = new Store(join(dir, 'test.db'), 'nobody');
  store.createOrg(ORG, 'Org A');
  store.createDevice(IMEI, ORG, 'Reader 379');
  config = loadConfig();
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('decodeTagDiscovery', () => {
  it('decodes the advanced two-record fixture exactly', () => {
    const result = decodeTagDiscovery(bytes(ADVANCED_TWO_RECORDS));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { campaign } = result;
    expect(campaign.primaryDeviceId).toBe(PRIMARY_DEVICE_ID);
    expect(campaign.primaryTagId).toBe('A1B2C3');
    expect(campaign.primaryVersion).toBe(20400);
    expect(campaign.sessionUtc).toBe(SESSION_UTC);
    expect(campaign.mode).toBe(0);
    expect(campaign.skippedRecords).toBe(0);
    expect(campaign.tags).toHaveLength(2);

    // Tag ABCD: 1 hop, wave 2, -87 dBm, 4012 mV, still, -25.123456/28.456789,
    // patch 8, RSSI relayed via node B2C3, fix valid.
    expect(campaign.tags[0]).toEqual({
      id: 'ABCD',
      hops: 1,
      waveCount: 2,
      rssi: -87,
      battery: 4012,
      movementState: 1,
      lat: -25.123456,
      lon: 28.456789,
      hasGps: true,
      fwVersionPatch: 8,
      gpsAgeSeconds: null,
      linkId: 'B2C3',
    });

    // Tag 1234: 2 hops, wave 3, -102 dBm, 3890 mV, moving, no fix, patch 7, no link.
    expect(campaign.tags[1]).toEqual({
      id: '1234',
      hops: 2,
      waveCount: 3,
      rssi: -102,
      battery: 3890,
      movementState: 0,
      lat: null,
      lon: null,
      hasGps: false,
      fwVersionPatch: 7,
      gpsAgeSeconds: null,
      linkId: null,
    });
  });

  it('decodes the basic one-record fixture exactly', () => {
    const result = decodeTagDiscovery(bytes(BASIC_ONE_RECORD));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.campaign.mode).toBe(1);
    // Tag 3E1E, 3637 mV, -68 dBm, still, patch 22, fix valid and 345 s old.
    expect(result.campaign.tags).toEqual([
      {
        id: '3E1E',
        hops: null,
        waveCount: null,
        rssi: -68,
        battery: 3637,
        movementState: 1,
        lat: -25.123456,
        lon: 28.456789,
        hasGps: true,
        fwVersionPatch: 22,
        gpsAgeSeconds: 345,
        linkId: null,
      },
    ]);
  });

  it('treats an empty campaign as a valid result, not an error', () => {
    const result = decodeTagDiscovery(bytes(EMPTY_CAMPAIGN));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.campaign.tags).toEqual([]);
    expect(result.campaign.skippedRecords).toBe(0);
  });

  it('renders ids as unpadded uppercase hex, the way the log path stores them', () => {
    // 43981 -> ABCD and 15902 -> 3E1E, matching the firmware's own `%X` output.
    const advanced = decodeTagDiscovery(bytes(ADVANCED_TWO_RECORDS));
    const basic = decodeTagDiscovery(bytes(BASIC_ONE_RECORD));
    expect(advanced.ok && advanced.campaign.tags.map((t) => t.id)).toEqual(['ABCD', '1234']);
    expect(basic.ok && basic.campaign.tags[0]?.id).toBe('3E1E');
  });

  it('trusts gpsValid over the coordinates in advanced mode', () => {
    // Advanced records carry the tag's coordinates raw even when the fix is
    // bad, because the parallel CSV log block prints them raw — so a non-zero
    // coordinate with gpsValid 0 must still read as "no fix".
    const body = buildAdvanced([[0xabcd, 1, 2, -87, 4012, 1, -25_123_456, 28_456_789, 8, 0, 0]]);
    const result = decodeTagDiscovery(body);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.campaign.tags[0]).toMatchObject({ hasGps: false, lat: null, lon: null });
  });

  it('carries moveState through unchanged — 0 is moving, 1 is still', () => {
    const body = buildAdvanced([
      [0xabcd, 1, 1, -80, 4000, 0, 0, 0, 1, 0, 0],
      [0x1234, 1, 1, -80, 4000, 1, 0, 0, 1, 0, 0],
    ]);
    const result = decodeTagDiscovery(body);
    expect(result.ok && result.campaign.tags.map((t) => t.movementState)).toEqual([0, 1]);
  });

  it('maps rssiSrc 0 to a null linkId', () => {
    const body = buildAdvanced([[0xabcd, 1, 1, -80, 4000, 1, 0, 0, 1, 0, 1]]);
    const result = decodeTagDiscovery(body);
    expect(result.ok && result.campaign.tags[0]?.linkId).toBeNull();
  });

  it('accepts every encoding width the firmware might pick for a field', () => {
    // The same logical field is 1, 2, 3 or 5 bytes wide depending on magnitude.
    const body = buildAdvanced([
      [0x0a, 1, 1, -1, 23, 1, 0, 0, 0, 0, 0],
      [0xffff, 24, 6, -255, 65_535, 0, -179_999_999, 179_999_999, 255, 0xffff, 1],
    ]);
    const result = decodeTagDiscovery(body);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.campaign.tags.map((t) => t.id)).toEqual(['A', 'FFFF']);
    expect(result.campaign.tags[1]).toMatchObject({ rssi: -255, battery: 65_535, lat: -179.999999, lon: 179.999999 });
  });

  it('drops the firmware\'s own pseudo-devices, as the log path does', () => {
    // An 8-hex-character id is a FOTA progress row, not a tag.
    const body = buildAdvanced([
      [0xf9000000, 1, 1, -80, 4000, 1, 0, 0, 1, 0, 0],
      [0xabcd, 1, 1, -80, 4000, 1, 0, 0, 1, 0, 0],
    ]);
    const result = decodeTagDiscovery(body);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.campaign.tags.map((t) => t.id)).toEqual(['ABCD']);
    expect(result.campaign.skippedRecords).toBe(1);
  });

  it('rejects a body that is not a CBOR map', () => {
    expect(decodeTagDiscovery(bytes('80'))).toEqual({ ok: false, error: expect.stringContaining('not a CBOR map') });
  });

  it('rejects an empty body and one with trailing bytes', () => {
    expect(decodeTagDiscovery(new Uint8Array(0)).ok).toBe(false);
    expect(decodeTagDiscovery(bytes(`${EMPTY_CAMPAIGN}FF`)).ok).toBe(false);
  });

  it('rejects an unknown mode and a missing key', () => {
    const badMode = decodeTagDiscovery(bytes('A5011A00A1B2C302194FB0031A6AA1F94004020580'));
    expect(badMode).toEqual({ ok: false, error: expect.stringContaining('mode') });
    // Four keys only — key 3 (sessionUtc) dropped.
    const missing = decodeTagDiscovery(bytes('A4011A00A1B2C302194FB004000580'));
    expect(missing).toEqual({ ok: false, error: expect.stringContaining('sessionUtc') });
  });

  it('rejects more records than the firmware can send', () => {
    const record: number[] = [0xabcd, 1, 1, -80, 4000, 1, 0, 0, 1, 0, 0];
    const result = decodeTagDiscovery(buildAdvanced(Array.from({ length: 65 }, () => record)));
    expect(result).toEqual({ ok: false, error: expect.stringContaining('65') });
  });

  it('reads key 6 (durationS) when the firmware sends it', () => {
    const result = decodeTagDiscovery(buildAdvanced([], 47));
    expect(result.ok && result.campaign.durationSeconds).toBe(47);
  });

  it('treats a missing key 6 as null, not an error — older firmware omits it', () => {
    // All three captured fixtures predate key 6.
    const fixture = decodeTagDiscovery(bytes(ADVANCED_TWO_RECORDS));
    expect(fixture.ok && fixture.campaign.durationSeconds).toBeNull();
    const decoded = decodeTagDiscovery(buildAdvanced([]));
    expect(decoded.ok && decoded.campaign.durationSeconds).toBeNull();
  });

  it('treats durationS 0 as "not measured", the firmware\'s own convention', () => {
    // Always 0 on a basic-mode campaign; also possible on advanced if the
    // primary genuinely has nothing to report yet.
    const result = decodeTagDiscovery(buildAdvanced([], 0));
    expect(result.ok && result.campaign.durationSeconds).toBeNull();
  });
});

describe('formatPrimaryVersion', () => {
  it('unpacks MMmmpp into the string the log path scrapes', () => {
    expect(formatPrimaryVersion(20400)).toBe('v2.4.0');
    expect(formatPrimaryVersion(91213)).toBe('v9.12.13');
    // 0 means the primary predates the field carrying it.
    expect(formatPrimaryVersion(0)).toBeNull();
  });
});

describe('bracketForSession', () => {
  it('rounds to the same bracket the log path buckets blocks into', () => {
    const bracketMs = 15 * 60_000;
    const at = Date.parse('2026-07-22T09:07:00Z') / 1000;
    expect(bracketForSession(at, at * 1000, 15)).toBe(Math.round((at * 1000) / bracketMs) * bracketMs);
  });

  it('refuses a clock that has not been set since a cold boot', () => {
    expect(bracketForSession(0, NOW_MS, 15)).toBeNull();
    expect(bracketForSession(86_400, NOW_MS, 15)).toBeNull();
  });

  it('refuses a clock implausibly far ahead of us', () => {
    expect(bracketForSession(Math.floor(NOW_MS / 1000) + 10 * 86_400, NOW_MS, 15)).toBeNull();
  });
});

describe('storeTagDiscovery', () => {
  /** What the log-scraping path would have written for the same round. */
  function scrapedRound(bracketAt: number, partial: Partial<RoundInput>): RoundInput {
    return {
      bracketAt,
      deviceImei: IMEI,
      tagCount: 2,
      durationSeconds: null,
      unitBatteryMv: null,
      readerFw: 'v2.4.0',
      timedOut: false,
      source: 'log',
      receivedAt: null,
      ...partial,
    };
  }

  function decoded(hex: string) {
    const result = decodeTagDiscovery(bytes(hex));
    if (!result.ok) throw new Error(result.error);
    return result.campaign;
  }

  it('writes readings and a round for a known device', () => {
    const result = storeTagDiscovery(store, config, IMEI, decoded(ADVANCED_TWO_RECORDS), NOW_MS, 65);
    expect(result.outcome).toBe('stored');
    expect(result.readingsWritten).toBe(2);

    const bracketAt = result.bracketAt as number;
    const readings = store.listReadingsWindow(ORG, bracketAt - 1, bracketAt + 1);
    expect(readings.map((r) => r.tag_id).sort()).toEqual(['1234', 'ABCD']);
    const abcd = readings.find((r) => r.tag_id === 'ABCD');
    expect(abcd).toMatchObject({ rssi: -87, battery_mv: 4012, hops: 1, wave_count: 2, has_gps: 1, link_id: 'B2C3' });

    const rounds = store.listRoundsWindow(ORG, bracketAt - 1, bracketAt + 1);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toMatchObject({ tag_count: 2, reader_fw: 'v2.4.0', timed_out: 0 });
  });

  it('stores an empty campaign as a real round of zero tags', () => {
    const result = storeTagDiscovery(store, config, IMEI, decoded(EMPTY_CAMPAIGN), NOW_MS, 21);
    expect(result.outcome).toBe('stored');
    expect(result.readingsWritten).toBe(0);
    const bracketAt = result.bracketAt as number;
    expect(store.listRoundsWindow(ORG, bracketAt - 1, bracketAt + 1)).toHaveLength(1);
  });

  it('dedupes a retried campaign on (imei, primaryDeviceId, sessionUtc)', () => {
    const campaign = decoded(ADVANCED_TWO_RECORDS);
    expect(storeTagDiscovery(store, config, IMEI, campaign, NOW_MS, 65).outcome).toBe('stored');
    // The unit retries when our 200 is lost on the way back; the identical
    // campaign arriving again must be a no-op, not a second set of rows.
    const second = storeTagDiscovery(store, config, IMEI, campaign, NOW_MS + 5_000, 65);
    expect(second.outcome).toBe('duplicate');
    expect(second.readingsWritten).toBe(0);
    expect(store.listTagDiscoveryPosts(IMEI)).toHaveLength(1);
  });

  it('refuses a device it has never heard of', () => {
    const result = storeTagDiscovery(store, config, UNKNOWN_IMEI, decoded(EMPTY_CAMPAIGN), NOW_MS, 21);
    expect(result).toEqual({ outcome: 'unknown-device', readingsWritten: 0, bracketAt: null });
  });

  it('refuses a campaign stamped with an unset RTC', () => {
    const campaign = { ...decoded(EMPTY_CAMPAIGN), sessionUtc: 0 };
    expect(storeTagDiscovery(store, config, IMEI, campaign, NOW_MS, 21).outcome).toBe('bad-clock');
  });

  it('records the reported primary as exact evidence of this reader’s radio id', () => {
    // A campaign states its own primary's LoRa id, which *is* the value
    // `devices.radio_id` holds — so for a pushing unit this is not a guess.
    storeTagDiscovery(store, config, IMEI, decoded(ADVANCED_TWO_RECORDS), NOW_MS, 65);
    expect(store.listIdentityCandidates(IMEI, 'radio')).toMatchObject([{ exact: true, rounds: 1 }]);
  });

  describe('live announcements', () => {
    function collect(): { bus: ReturnType<typeof createLiveBus>; seen: LiveEvent[] } {
      const bus = createLiveBus();
      const seen: LiveEvent[] = [];
      bus.subscribe(ORG, (e) => seen.push(e));
      return { bus, seen };
    }

    it('announces a stored campaign once, so open browsers re-read', () => {
      const { bus, seen } = collect();
      storeTagDiscovery(store, config, IMEI, decoded(ADVANCED_TWO_RECORDS), NOW_MS, 65, bus);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ type: 'readings', orgId: ORG, imei: IMEI });
    });

    it('says nothing about a retried campaign', () => {
      // Otherwise the firmware's retry-on-lost-200 would make every open
      // browser re-fetch for data it already has.
      const { bus, seen } = collect();
      const campaign = decoded(ADVANCED_TWO_RECORDS);
      storeTagDiscovery(store, config, IMEI, campaign, NOW_MS, 65, bus);
      storeTagDiscovery(store, config, IMEI, campaign, NOW_MS + 5_000, 65, bus);
      expect(seen).toHaveLength(1);
    });

    it('says nothing about a campaign it could not store', () => {
      const { bus, seen } = collect();
      storeTagDiscovery(store, config, UNKNOWN_IMEI, decoded(EMPTY_CAMPAIGN), NOW_MS, 21, bus);
      storeTagDiscovery(store, config, IMEI, { ...decoded(EMPTY_CAMPAIGN), sessionUtc: 0 }, NOW_MS, 21, bus);
      expect(seen).toEqual([]);
    });
  });

  it('writes the campaign-reported duration onto a fresh round', () => {
    const campaign = decodeTagDiscovery(buildAdvanced([[0xabcd, 1, 1, -80, 4000, 1, 0, 0, 1, 0, 0]], 52));
    if (!campaign.ok) throw new Error(campaign.error);

    const result = storeTagDiscovery(store, config, IMEI, campaign.campaign, NOW_MS, 65);
    const bracketAt = result.bracketAt as number;
    const rounds = store.listRoundsWindow(ORG, bracketAt - 1, bracketAt + 1);
    expect(rounds[0]).toMatchObject({ duration_seconds: 52 });
  });

  it('leaves duration null on a fresh round when the firmware sent none', () => {
    const result = storeTagDiscovery(store, config, IMEI, decoded(EMPTY_CAMPAIGN), NOW_MS, 21);
    const bracketAt = result.bracketAt as number;
    const rounds = store.listRoundsWindow(ORG, bracketAt - 1, bracketAt + 1);
    expect(rounds[0]).toMatchObject({ duration_seconds: null });
  });

  it('takes precedence over a round the log-scraping path already wrote', () => {
    const campaign = decodeTagDiscovery(buildAdvanced([[0xabcd, 1, 1, -80, 4000, 1, 0, 0, 1, 0, 0]], 52));
    if (!campaign.ok) throw new Error(campaign.error);
    const bracketAt = bracketForSession(campaign.campaign.sessionUtc, NOW_MS, config.bracketMinutes) as number;

    // The scrape got there first with its inferred 47s.
    store.writeReadings([], [scrapedRound(bracketAt, { durationSeconds: 47, unitBatteryMv: 4019 })]);

    storeTagDiscovery(store, config, IMEI, campaign.campaign, NOW_MS, 65);

    const rounds = store.listRoundsWindow(ORG, bracketAt - 1, bracketAt + 1);
    expect(rounds).toHaveLength(1);
    // The firmware's own on-air 52s wins over the scrape's estimate, and the
    // round is now stamped with when it actually reached us...
    expect(rounds[0]).toMatchObject({ duration_seconds: 52, source: 'cbor', received_at: NOW_MS });
    // ...but the supply voltage, which only the log ever carries, is kept.
    expect(rounds[0]).toMatchObject({ unit_battery_mv: 4019 });
  });

  it('is not written back over by a later log scrape of the same round', () => {
    const campaign = decodeTagDiscovery(buildAdvanced([[0xabcd, 1, 1, -80, 4000, 1, 0, 0, 1, 0, 0]], 52));
    if (!campaign.ok) throw new Error(campaign.error);

    const result = storeTagDiscovery(store, config, IMEI, campaign.campaign, NOW_MS, 65);
    const bracketAt = result.bracketAt as number;

    // The same campaign comes round again by the slower route, carrying the
    // coarser duration and the one thing the push could not: supply voltage.
    store.writeReadings(
      [
        {
          bracketAt,
          deviceImei: IMEI,
          tagId: 'ABCD',
          batteryMv: 3111,
          rssi: -99,
          hops: 9,
          waveCount: 9,
          movementState: 0,
          lat: null,
          lon: null,
          hasGps: false,
          fwPatch: 1,
          gpsAgeSeconds: null,
          linkId: null,
          source: 'log',
        },
      ],
      [scrapedRound(bracketAt, { durationSeconds: 47, unitBatteryMv: 4019 })],
    );

    const rounds = store.listRoundsWindow(ORG, bracketAt - 1, bracketAt + 1);
    expect(rounds[0]).toMatchObject({ duration_seconds: 52, source: 'cbor', received_at: NOW_MS });
    expect(rounds[0]).toMatchObject({ unit_battery_mv: 4019 });

    // Down to the reading row: the scrape's values do not land on top of the
    // pushed ones either.
    const abcd = store.listReadingsWindow(ORG, bracketAt - 1, bracketAt + 1).find((r) => r.tag_id === 'ABCD');
    expect(abcd).toMatchObject({ battery_mv: 4000, rssi: -80, source: 'cbor' });
  });

  it('stamps the round with the exact time the POST arrived, not just its bracket', () => {
    const result = storeTagDiscovery(store, config, IMEI, decoded(ADVANCED_TWO_RECORDS), NOW_MS, 65);
    const bracketAt = result.bracketAt as number;

    const rounds = store.listRoundsWindow(ORG, bracketAt - 1, bracketAt + 1);
    expect(rounds[0]).toMatchObject({ source: 'cbor', received_at: NOW_MS });
    // The bracket is still the key both paths meet on — the arrival time rides
    // alongside it rather than replacing it.
    expect(NOW_MS).not.toBe(bracketAt);
  });

  it('lands a pushed reading on the row the scraped path already made for that tag', () => {
    const campaign = decoded(ADVANCED_TWO_RECORDS);
    const bracketAt = bracketForSession(campaign.sessionUtc, NOW_MS, config.bracketMinutes) as number;
    store.writeReadings(
      [
        {
          bracketAt,
          deviceImei: IMEI,
          tagId: 'ABCD',
          batteryMv: 4012,
          rssi: -87,
          hops: 1,
          waveCount: 2,
          movementState: 1,
          lat: -25.123456,
          lon: 28.456789,
          hasGps: true,
          fwPatch: 8,
          gpsAgeSeconds: null,
          linkId: 'B2C3',
          source: 'log',
        },
      ],
      [],
    );

    storeTagDiscovery(store, config, IMEI, campaign, NOW_MS, 65);

    // One row per (bracket, device, tag), not two — the hex id rendering is
    // what makes the two paths agree on the key.
    const abcd = store.listReadingsWindow(ORG, bracketAt - 1, bracketAt + 1).filter((r) => r.tag_id === 'ABCD');
    expect(abcd).toHaveLength(1);
  });
});

describe('POST /:imei/tagdiscovery', () => {
  function post(imei: string, body: Uint8Array) {
    const api = createTagDiscoveryApi({ store, config });
    return api.request(`/${imei}/tagdiscovery`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body,
    });
  }

  beforeEach(() => {
    // The endpoint logs every request's raw hex for this first field round; the
    // fixtures would otherwise fill the test output with it.
    vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.setSystemTime(NOW_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('answers 200 and stores the campaign', async () => {
    const res = await post(IMEI, bytes(ADVANCED_TWO_RECORDS));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, outcome: 'stored', records: 2, readingsWritten: 2 });
  });

  it('answers 200 for an empty campaign', async () => {
    const res = await post(IMEI, bytes(EMPTY_CAMPAIGN));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, outcome: 'stored', records: 0 });
  });

  it('answers 200 even when the body is undecodable', async () => {
    // A non-200 costs us the campaign outright: the unit retries once inside
    // the same session and then drops it rather than persisting it. Logging
    // the raw bytes is worth more than a status code nothing acts on.
    const res = await post(IMEI, bytes('DEADBEEF'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false });
  });

  it('answers 200 for an unregistered IMEI and a malformed one', async () => {
    const unknown = await post(UNKNOWN_IMEI, bytes(EMPTY_CAMPAIGN));
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toMatchObject({ outcome: 'unknown-device' });

    const malformed = await post('not-an-imei', bytes(EMPTY_CAMPAIGN));
    expect(malformed.status).toBe(200);
    expect(await malformed.json()).toMatchObject({ ok: false });
  });

  it('answers 200 to a retry and does not double-write', async () => {
    await post(IMEI, bytes(BASIC_ONE_RECORD));
    const retry = await post(IMEI, bytes(BASIC_ONE_RECORD));
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ ok: true, outcome: 'duplicate' });
    expect(store.listTagDiscoveryPosts(IMEI)).toHaveLength(1);
  });

  it('does not accept a GET, so the catch-all API keeps its own paths', async () => {
    const api = createTagDiscoveryApi({ store, config });
    expect((await api.request(`/${IMEI}/tagdiscovery`)).status).toBe(404);
  });
});

// --- Fixture builder ------------------------------------------------------
// The same rules the firmware's encoder uses: narrowest integer encoding,
// definite lengths, negative integers as CBOR major type 1. Used for the cases
// the three captured fixtures do not cover.

const UINT = 0 << 5;
const NEG = 1 << 5;
const ARR = 4 << 5;
const MAP = 5 << 5;

function head(major: number, arg: number): number[] {
  if (arg < 24) return [major | arg];
  if (arg <= 0xff) return [major | 24, arg];
  if (arg <= 0xffff) return [major | 25, (arg >> 8) & 0xff, arg & 0xff];
  return [major | 26, (arg >>> 24) & 0xff, (arg >>> 16) & 0xff, (arg >>> 8) & 0xff, arg & 0xff];
}

function int(value: number): number[] {
  return value >= 0 ? head(UINT, value) : head(NEG, -(value + 1));
}

/** `durationS` omitted (the default) matches firmware that predates key 6. */
function buildAdvanced(records: number[][], durationS?: number): Uint8Array {
  const out: number[] = [
    ...head(MAP, durationS === undefined ? 5 : 6),
    ...int(1),
    ...int(PRIMARY_DEVICE_ID),
    ...int(2),
    ...int(20400),
    ...int(3),
    ...int(SESSION_UTC),
    ...int(4),
    ...int(0),
    ...int(5),
    ...head(ARR, records.length),
  ];
  for (const record of records) {
    out.push(...head(ARR, record.length));
    for (const value of record) out.push(...int(value));
  }
  if (durationS !== undefined) out.push(...int(6), ...int(durationS));
  return new Uint8Array(out);
}
