import { mergeSessions, parseLogText, type DiscoveryBlock, type DiscoverySession } from '@tagexplore/core';
import type { Config } from '../config.js';
import type { ReadingInput, RoundInput, Store } from '../db/index.js';
import type { LiveBus } from '../events/bus.js';
import { fetchDeviceSchedule, fetchUnitLogText } from './farmrangerClient.js';
import { pollDevicePosition } from './position.js';

export interface IngestResult {
  imei: string;
  blocksParsed: number;
  readingsWritten: number;
  from: Date;
  to: Date;
}

/** How much log a single API call asks for during a backfill. */
const BACKFILL_CHUNK_MS = 24 * 3_600_000;

/**
 * Fetches, parses and stores one device's logs for a time range.
 *
 * Blocks are merged per device rather than across the fleet: a reading row is
 * keyed by the device that heard it, so two devices hearing the same tag in the
 * same round are two rows, and the "which of these is current" question is
 * answered at query time. What the merge does here is fold a device's own
 * duplicate blocks — a timed-out attempt and the retry seconds later — into the
 * single round they actually represent.
 */
export async function ingestRange(
  store: Store,
  config: Config,
  imei: string,
  from: Date,
  to: Date,
): Promise<IngestResult> {
  const text = await fetchUnitLogText(config, imei, from, to);
  const blocks = parseLogText(text, imei);
  const written = storeBlocks(store, config, imei, blocks);
  return { imei, blocksParsed: blocks.length, readingsWritten: written, from, to };
}

function storeBlocks(store: Store, config: Config, imei: string, blocks: DiscoveryBlock[]): number {
  const sessions = mergeSessions({ [imei]: blocks }, config.bracketMinutes);

  // The reading device's own supply voltage is a property of the log line, not
  // of the merged round, so it is collected off the blocks and matched back by
  // bracket. Earliest block in the bracket wins, matching how the round's
  // duration is measured from its first successful reading.
  const bracketMs = config.bracketMinutes * 60_000;
  const unitBatteryByBracket = new Map<number, number>();
  for (const block of [...blocks].sort((a, b) => a.timestamp.localeCompare(b.timestamp))) {
    if (block.unitBatteryMv === null) continue;
    const bracket = Math.round(new Date(block.timestamp).getTime() / bracketMs) * bracketMs;
    if (!unitBatteryByBracket.has(bracket)) unitBatteryByBracket.set(bracket, block.unitBatteryMv);
  }

  const readings: ReadingInput[] = [];
  const rounds: RoundInput[] = [];

  for (const session of sessions) {
    const bracketAt = new Date(session.timestamp).getTime();
    const unitBatteryMv = unitBatteryByBracket.get(bracketAt) ?? null;

    if (session.discarded) {
      rounds.push({
        bracketAt,
        deviceImei: imei,
        tagCount: 0,
        durationSeconds: null,
        unitBatteryMv,
        readerFw: null,
        timedOut: true,
        source: 'log',
        receivedAt: null,
      });
      continue;
    }

    const good = session as DiscoverySession;
    rounds.push({
      bracketAt,
      deviceImei: imei,
      tagCount: good.total,
      // Still inferred here, and only here: bracket boundary to the round's
      // last good block. A unit that can POST its campaign reports the real
      // figure instead and that one wins — see `writeReadings`.
      durationSeconds: good.durationSeconds,
      unitBatteryMv,
      readerFw: good.perDeviceFwVersion[imei] ?? null,
      timedOut: false,
      source: 'log',
      // A scraped round has no arrival time: the log is read long after the
      // fact, so all it can be tied to is the bracket its blocks fell in.
      receivedAt: null,
    });

    for (const tag of good.tags) {
      readings.push({
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
        source: 'log',
      });
    }
  }

  // Each round is written to the discovery it belongs to rather than straight
  // to its bracket — a push of the same campaign is keyed by its exact session
  // time, and another reader may already have started the discovery. Half a
  // bracket either side, the same window the push path joins within.
  store.writeReadings(readings, rounds, { anchorWindowMs: bracketMs / 2 });
  return readings.length;
}

/**
 * Brings one device up to date, recording the attempt in `ingest_runs` either
 * way so a device that has been failing silently is visible in the admin view.
 *
 * A device with no readings yet is backfilled `backfillDays` back, a day per
 * request; one that has reported before is read from its newest bracket less
 * the configured overlap.
 */
export async function ingestDevice(
  store: Store,
  config: Config,
  imei: string,
  now = new Date(),
  bus?: LiveBus,
): Promise<IngestResult> {
  const runId = store.startIngestRun(imei);
  const latest = store.latestBracketFor(imei);

  const start = latest === null
    ? new Date(now.getTime() - config.backfillDays * 86_400_000)
    : new Date(latest - config.pollLookbackHours * 3_600_000);

  try {
    let blocksParsed = 0;
    let readingsWritten = 0;
    // Chunked so a week-long backfill is several modest responses rather than
    // one enormous one; a routine poll is a single chunk.
    for (let cursor = start.getTime(); cursor < now.getTime(); cursor += BACKFILL_CHUNK_MS) {
      const chunkTo = new Date(Math.min(cursor + BACKFILL_CHUNK_MS, now.getTime()));
      const result = await ingestRange(store, config, imei, new Date(cursor), chunkTo);
      blocksParsed += result.blocksParsed;
      readingsWritten += result.readingsWritten;
    }

    store.finishIngestRun(runId, 'ok', { blocksParsed, readingsWritten });
    store.markDeviceIngest(imei, Date.now(), 'ok');

    // Published once here rather than inside the chunk loop: a seven-day
    // backfill is seven `ingestRange` calls, and the browser only needs to be
    // told the device is done, not counted through.
    if (readingsWritten > 0) {
      const device = store.getDevice(imei);
      if (device) bus?.publish({ type: 'readings', orgId: device.orgId, imei, at: Date.now() });
    }

    return { imei, blocksParsed, readingsWritten, from: start, to: now };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    store.finishIngestRun(runId, 'error', { blocksParsed: 0, readingsWritten: 0 }, message);
    store.markDeviceIngest(imei, Date.now(), `error: ${message.slice(0, 200)}`);
    throw err;
  }
}

/**
 * Everything the admin's per-device "Read now" means: the device's schedule
 * (in case an admin changed it on the platform since we last checked), its
 * log, and its own position and geofences.
 *
 * The position read is spelled out here rather than left to the scheduler's
 * own cadence, and it deliberately bypasses that cadence's debounce — "Read
 * now" has to mean everything, now, or it is no use as the thing you reach for
 * when a reader looks stuck.
 */
export async function refreshDeviceFully(
  store: Store,
  config: Config,
  imei: string,
  now = new Date(),
  bus?: LiveBus,
): Promise<IngestResult> {
  // Best-effort and silent: a settings API hiccup should not stop the log
  // ingest that actually matters more.
  try {
    const schedule = await fetchDeviceSchedule(config, imei);
    if (schedule) store.updateDevice(imei, schedule);
  } catch {
    // Ignored — see above.
  }
  const result = await ingestDevice(store, config, imei, now, bus);
  await pollDevicePosition(store, config, bus, imei);
  return result;
}
