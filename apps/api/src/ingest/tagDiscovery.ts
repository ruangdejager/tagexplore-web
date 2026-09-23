/**
 * Push ingest: a FarmRanger unit POSTs one tag-discovery campaign to us as
 * CBOR, instead of us pulling its syslog and scraping the same campaign back
 * out of the log text.
 *
 * This runs *alongside* the log path, not instead of it — the firmware still
 * writes the identical block into its flash syslog and that syslog is still
 * fetched, parsed and stored by `ingest.ts` / `logParser.ts`. So the same
 * campaign is expected to arrive twice by two routes for a while, which is
 * deliberate: it lets the two be diffed.
 *
 * Where the two disagree, **this path wins**. A pushed campaign carries two
 * things a scrape cannot reconstruct — the firmware's own on-air measurement of
 * how long the discovery took, and the exact moment the data reached the server
 * — against the scrape's 15-minute bracket and a duration inferred from it. The
 * scraped path keeps inferring both for the field units that can only be
 * scraped; it just no longer writes back over a round that was pushed.
 *
 * The body is a definite-length CBOR map with small unsigned-integer keys:
 *
 *   1: primaryDeviceId  uint32  the reporting primary tag's own LoRa id
 *   2: primaryVersion   uint32  packed major*10000 + minor*100 + patch
 *   3: sessionUtc       uint32  unix seconds, the *unit's* RTC when it accepted
 *                               the campaign — not when the campaign was captured
 *   4: mode             uint    0 = advanced, 1 = basic
 *   5: records          array   positional arrays, 0..64 (advanced) / 0..32 (basic);
 *                               an empty array, or the key left out entirely,
 *                               is a campaign that heard nothing
 *   6: durationS        uint    seconds, the unit's own measurement of how long
 *                               the discovery campaign took; 0 = not measured
 *                               (always 0 on a basic-mode campaign — see below)
 *
 * Every value is an unsigned integer, a negative integer, an array or the map
 * itself: no tags, no floats, no text strings, no indefinite lengths. The
 * firmware always picks the narrowest encoding for each value, so a field
 * arrives 1, 2, 3 or 5 bytes wide depending on its magnitude — which is why
 * this decodes with a real CBOR library rather than fixed offsets.
 *
 * Key 6 (durationS) postdates keys 1-5: a unit on older firmware simply omits
 * it, and that is treated as "not measured" rather than an error — the same
 * way an old primary reports `primaryVersion: 0`. Any future key is meant to
 * be additive like this one; an unrecognised key is ignored, never rejected.
 */

import { decode } from 'cbor2';
import { formatTagId, type TagReading } from '@tagexplore/core';
import type { Config } from '../config.js';
import type { ReadingInput, Store } from '../db/index.js';
import type { LiveBus } from '../events/bus.js';

export const MODE_ADVANCED = 0;
export const MODE_BASIC = 1;

/** Record shapes are positional, so the item count is the only structural check. */
const ADVANCED_ITEMS = 11;
const BASIC_ITEMS = 9;

/**
 * Firmware fan-out limits. A body larger than the biggest legal campaign can
 * never have come from this firmware (its own send buffer is 2560 bytes), so
 * an over-long array is a decoder or corruption problem, not a big campaign.
 */
const MAX_ADVANCED_RECORDS = 64;
const MAX_BASIC_RECORDS = 32;

/**
 * `sessionUtc` is whatever the unit's RTC said, and a unit that cold-booted
 * without a time sync will happily report 1970 — so it is sanity-checked
 * rather than trusted. The upper bound allows a day of clock skew ahead of us.
 */
const MIN_SESSION_UTC = Math.floor(Date.parse('2020-01-01T00:00:00Z') / 1000);
const MAX_SESSION_SKEW_SECONDS = 86_400;

export interface TagDiscoveryCampaign {
  primaryDeviceId: number;
  /** `primaryDeviceId` in the same hex form tag ids are stored as. */
  primaryTagId: string | null;
  /** Packed `major*10000 + minor*100 + patch`; 0 when the primary predates the field. */
  primaryVersion: number;
  /** Unix seconds, unvalidated — see `bracketForSession`. */
  sessionUtc: number;
  mode: typeof MODE_ADVANCED | typeof MODE_BASIC;
  /**
   * The unit's own measurement of how long the campaign took, in seconds.
   * `null` when absent (older firmware) or reported as 0 ("not measured" —
   * always true for a basic-mode campaign; see the module doc). Distinct from
   * `rounds.duration_seconds` on the scraped path, which instead measures
   * bracket-to-first-good-block across every device in the round — this is
   * the actual on-air campaign time, reported directly instead of inferred.
   */
  durationSeconds: number | null;
  tags: TagReading[];
  /** Records that decoded but could not be mapped (unusable id, wrong item count). */
  skippedRecords: number;
}

export type DecodeResult =
  | { ok: true; campaign: TagDiscoveryCampaign }
  | { ok: false; error: string };

function isInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

/** `bigint` is what a conformant decoder yields for a value past 2^53; none of ours are. */
function readInt(map: Map<unknown, unknown>, key: number): number | null {
  const value = map.get(key);
  return isInt(value) ? value : null;
}

/**
 * Turns the packed `MMmmpp` version into the same string the log path scrapes
 * out of `Tag Discovery (advanced) primary v2.4.0:`, so both ingest paths
 * write the identical `rounds.reader_fw` for the same primary. `0` means the
 * primary is too old to report it at all.
 */
export function formatPrimaryVersion(packed: number): string | null {
  if (!isInt(packed) || packed <= 0) return null;
  const major = Math.floor(packed / 10_000);
  const minor = Math.floor(packed / 100) % 100;
  const patch = packed % 100;
  return `v${major}.${minor}.${patch}`;
}

/**
 * A tag id longer than 4 hex characters is one of the firmware's own
 * pseudo-devices rather than a tag — a FOTA transfer reports a row per chunk
 * with an 8-character progress id. `logParser.parseTagRow` drops those on the
 * scraped path, so they are dropped here too; otherwise the two paths would
 * disagree about a round's tag list.
 */
function tagIdFrom(value: unknown): string | null {
  if (!isInt(value)) return null;
  const id = formatTagId(value);
  if (id === null || id.length > 4) return null;
  return id;
}

/**
 * Coordinates arrive as fixed-point microdegrees. In *advanced* mode the
 * firmware sends them exactly as the tag reported them even when the fix is
 * invalid, because the parallel CSV log block has always printed them raw —
 * so a non-zero coordinate with `gpsValid == 0` is a stale reading, not a
 * contradiction. In *basic* mode they are zeroed instead. Either way the flag
 * is the authority, which is the whole point of it: the scraped path has no
 * such flag and has to infer "no fix" from `lat == 0 && lon == 0`.
 */
function coordinate(microDegrees: unknown, hasGps: boolean): number | null {
  if (!hasGps || !isInt(microDegrees)) return null;
  return microDegrees / 1e6;
}

function advancedRecord(record: unknown[]): TagReading | null {
  if (record.length !== ADVANCED_ITEMS) return null;
  const [deviceId, hopCount, wave, rssi, batMv, moveState, latUDeg, lonUDeg, fwPatch, rssiSrc, gpsValid] = record;

  const id = tagIdFrom(deviceId);
  if (id === null || !isInt(rssi) || !isInt(batMv)) return null;

  const hasGps = gpsValid === 1;
  // `rssiSrc == 0` is the firmware's own "no link reported" value, the same
  // convention the log path's `RssiSrc` column uses.
  const linkId = isInt(rssiSrc) && rssiSrc !== 0 ? formatTagId(rssiSrc) : null;

  return {
    id,
    hops: isInt(hopCount) ? hopCount : null,
    waveCount: isInt(wave) ? wave : null,
    rssi,
    battery: batMv,
    // 0 = moving, 1 = still. That reads backwards, but it is the tag's own raw
    // field carried through unchanged so the two paths stay comparable.
    movementState: isInt(moveState) ? moveState : null,
    lat: coordinate(latUDeg, hasGps),
    lon: coordinate(lonUDeg, hasGps),
    hasGps,
    fwVersionPatch: isInt(fwPatch) ? fwPatch : null,
    // Advanced records do not carry a fix age at all; basic ones do.
    gpsAgeSeconds: null,
    linkId,
  };
}

function basicRecord(record: unknown[]): TagReading | null {
  if (record.length !== BASIC_ITEMS) return null;
  const [deviceId, batMv, rssi, moveState, fwPatch, latUDeg, lonUDeg, gpsAgeS, gpsValid] = record;

  const id = tagIdFrom(deviceId);
  if (id === null || !isInt(rssi) || !isInt(batMv)) return null;

  const hasGps = gpsValid === 1;

  return {
    id,
    // Basic mode reports neither, the same as a basic-mode log block.
    hops: null,
    waveCount: null,
    rssi,
    battery: batMv,
    movementState: isInt(moveState) ? moveState : null,
    lat: coordinate(latUDeg, hasGps),
    lon: coordinate(lonUDeg, hasGps),
    hasGps,
    fwVersionPatch: isInt(fwPatch) ? fwPatch : null,
    gpsAgeSeconds: hasGps && isInt(gpsAgeS) ? gpsAgeS : null,
    // Basic records carry no RssiSrc column, so there is never a link to name.
    linkId: null,
  };
}

/** Decodes and validates one POSTed campaign body. */
export function decodeTagDiscovery(body: Uint8Array): DecodeResult {
  if (body.length === 0) return { ok: false, error: 'Empty body.' };

  let decoded: unknown;
  try {
    decoded = decode(body);
  } catch (err) {
    return { ok: false, error: `Not decodable as CBOR: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!(decoded instanceof Map)) return { ok: false, error: 'Top-level item is not a CBOR map.' };

  const primaryDeviceId = readInt(decoded, 1);
  const primaryVersion = readInt(decoded, 2);
  const sessionUtc = readInt(decoded, 3);
  const mode = readInt(decoded, 4);
  const records = decoded.get(5);
  // Optional and postdates keys 1-5 — see the module doc. 0 is the firmware's
  // own "not measured" value, same convention as primaryVersion.
  const rawDurationSeconds = readInt(decoded, 6);
  const durationSeconds = rawDurationSeconds !== null && rawDurationSeconds > 0 ? rawDurationSeconds : null;

  if (primaryDeviceId === null) return { ok: false, error: 'Key 1 (primaryDeviceId) missing or not an integer.' };
  if (primaryVersion === null) return { ok: false, error: 'Key 2 (primaryVersion) missing or not an integer.' };
  if (sessionUtc === null) return { ok: false, error: 'Key 3 (sessionUtc) missing or not an integer.' };
  if (mode !== MODE_ADVANCED && mode !== MODE_BASIC) {
    return { ok: false, error: `Key 4 (mode) must be ${MODE_ADVANCED} or ${MODE_BASIC}, got ${String(decoded.get(4))}.` };
  }
  // A campaign that heard nothing may say so either way — an empty array, or
  // no key 5 at all — and both are results, not faults. The distinction that
  // still matters is a key 5 that is there and is not an array: that is a
  // malformed body, and calling it "heard nothing" would turn a decoder fault
  // into a recorded observation.
  if (records !== undefined && !Array.isArray(records)) {
    return { ok: false, error: 'Key 5 (records) is present but not an array.' };
  }
  const recordList: unknown[] = Array.isArray(records) ? records : [];

  const limit = mode === MODE_ADVANCED ? MAX_ADVANCED_RECORDS : MAX_BASIC_RECORDS;
  if (recordList.length > limit) {
    return { ok: false, error: `Record count ${recordList.length} exceeds the firmware's limit of ${limit}.` };
  }

  // No records is a meaningful, valid result — "this primary heard nothing this
  // cycle" — and is still posted, so it must not be treated as an error. It is
  // stored as a round of zero tags, which is how the count history shows a
  // discovery that ran and found nothing rather than showing nothing at all.
  const tags: TagReading[] = [];
  let skippedRecords = 0;
  for (const record of recordList) {
    const tag = Array.isArray(record)
      ? mode === MODE_ADVANCED
        ? advancedRecord(record)
        : basicRecord(record)
      : null;
    if (tag) tags.push(tag);
    else skippedRecords++;
  }

  return {
    ok: true,
    campaign: {
      primaryDeviceId,
      primaryTagId: formatTagId(primaryDeviceId),
      primaryVersion,
      sessionUtc,
      mode,
      durationSeconds,
      tags,
      skippedRecords,
    },
  };
}

/**
 * Rounds the campaign's `sessionUtc` to the bracket the log path buckets
 * blocks into. Returns null when the clock is unusable — a 1970 RTC is not a
 * discovery round. The push path itself no longer keys on this bracket — it
 * starts from `sessionMomentMs` instead.
 */
export function bracketForSession(sessionUtc: number, nowMs: number, bracketMinutes: number): number | null {
  const at = sessionMomentMs(sessionUtc, nowMs);
  if (at === null) return null;
  const bracketMs = bracketMinutes * 60_000;
  return Math.round(at / bracketMs) * bracketMs;
}

/**
 * The campaign's own moment in ms — the key a new pushed discovery starts at —
 * or null when the unit's RTC is plainly unset.
 */
export function sessionMomentMs(sessionUtc: number, nowMs: number): number | null {
  const maxUtc = Math.floor(nowMs / 1000) + MAX_SESSION_SKEW_SECONDS;
  if (!isInt(sessionUtc) || sessionUtc < MIN_SESSION_UTC || sessionUtc > maxUtc) return null;
  return sessionUtc * 1000;
}

export type TagDiscoveryOutcome =
  | 'stored'
  | 'duplicate'
  /** The IMEI in the path is not a device we know, so there is nothing to attach it to. */
  | 'unknown-device'
  /** `sessionUtc` failed its sanity check — the unit's RTC has not been set. */
  | 'bad-clock';

export interface TagDiscoveryStoreResult {
  outcome: TagDiscoveryOutcome;
  readingsWritten: number;
  bracketAt: number | null;
}

/**
 * Persists a decoded campaign against the reporting unit.
 *
 * Readings land in the same `readings` table the scraped path writes to, keyed
 * by the same `(bracket, device, tag)` — that is what makes a pushed reading
 * join against the rows already there for that tag rather than forming a
 * parallel set. Which `bracket_at` that is gets resolved by the store from the
 * campaign's session time (`Store.resolveDiscoveryAnchor`): a scrape of the
 * same campaign or another reader's round of the same discovery is joined,
 * while another campaign from this same reader always starts its own
 * discovery. The exact arrival time rides along on the round as `receivedAt`,
 * which is what the count history shows for a pushed round.
 *
 * Where the two paths disagree about a field, this one wins — see
 * `Store.writeTagDiscoveryPost`.
 */
export function storeTagDiscovery(
  store: Store,
  config: Config,
  imei: string,
  campaign: TagDiscoveryCampaign,
  receivedAtMs: number,
  byteCount: number,
  bus?: LiveBus,
): TagDiscoveryStoreResult {
  // A reading row is foreign-keyed to `devices`, so an unregistered IMEI has
  // nowhere to go. Reported rather than thrown: the unit gets its 200 either
  // way, and the campaign is still in its flash syslog for the scraped path.
  // The row is kept rather than discarded — it carries the organisation the
  // live event has to be published to.
  const device = store.getDevice(imei);
  if (!device) return { outcome: 'unknown-device', readingsWritten: 0, bracketAt: null };

  const sessionAt = sessionMomentMs(campaign.sessionUtc, receivedAtMs);
  if (sessionAt === null) return { outcome: 'bad-clock', readingsWritten: 0, bracketAt: null };
  // Half a bracket either side: the same reach the old nearest-bracket
  // rounding gave two readers' clocks, without its slot boundaries.
  const anchorWindowMs = (config.bracketMinutes * 60_000) / 2;
  // Provisional — the store stamps the resolved anchor over it.
  const bracketAt = sessionAt;

  const readings: ReadingInput[] = campaign.tags.map((tag) => ({
    bracketAt,
    deviceImei: imei,
    tagId: tag.id,
    batteryMv: Number.isFinite(tag.battery) ? Math.round(tag.battery) : null,
    rssi: Number.isFinite(tag.rssi) ? Math.round(tag.rssi) : null,
    hops: tag.hops,
    waveCount: tag.waveCount,
    movementState: tag.movementState,
    lat: tag.lat,
    lon: tag.lon,
    hasGps: tag.hasGps,
    fwPatch: tag.fwVersionPatch,
    gpsAgeSeconds: tag.gpsAgeSeconds,
    linkId: tag.linkId,
    source: 'cbor',
  }));

  const result = store.writeTagDiscoveryPost({
    deviceImei: imei,
    primaryDeviceId: campaign.primaryDeviceId,
    // This *is* the reader's radio id, reported rather than inferred — the
    // store records it as exact evidence alongside the receipt.
    primaryTagId: campaign.primaryTagId,
    sessionUtc: campaign.sessionUtc,
    receivedAt: receivedAtMs,
    bracketAt,
    anchorWindowMs,
    mode: campaign.mode,
    primaryVersion: campaign.primaryVersion,
    byteCount,
    readings,
    round: {
      bracketAt,
      deviceImei: imei,
      tagCount: readings.length,
      // The unit's own on-air campaign timer, as reported — nothing is inferred
      // from the bracket here (see TagDiscoveryCampaign.durationSeconds). Null
      // on older firmware or a basic-mode campaign, which measure nothing; the
      // scraped path's estimate then fills it if that round ever arrives.
      durationSeconds: campaign.durationSeconds,
      // Not reported over this endpoint: the unit's own supply voltage is
      // printed on the log's time marks, which this path has no equivalent of.
      // `writeTagDiscoveryPost` leaves an already-scraped value alone rather
      // than blanking it with this null.
      unitBatteryMv: null,
      readerFw: formatPrimaryVersion(campaign.primaryVersion),
      timedOut: false,
      source: 'cbor',
      // What makes this round's data tied to a real moment: when the POST
      // actually landed on the server.
      receivedAt: receivedAtMs,
    },
  });

  // Only a genuinely new campaign is announced. The firmware retries once when
  // our 200 is lost on the way back, and making every open browser refetch for
  // a campaign it already has would be pure noise.
  if (!result.duplicate) {
    bus?.publish({ type: 'readings', orgId: device.orgId, imei, at: receivedAtMs, bracketAt: result.bracketAt });
  }

  return {
    outcome: result.duplicate ? 'duplicate' : 'stored',
    readingsWritten: result.readingsWritten,
    bracketAt: result.bracketAt,
  };
}
