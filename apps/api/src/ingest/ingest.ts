import { mergeSessions, parseLogText, type DiscoveryBlock, type DiscoverySession } from '@tagexplore/core';
import type { Config } from '../config.js';
import type { ReadingInput, RoundInput, Store } from '../db/index.js';
import { fetchUnitLogText } from './farmrangerClient.js';

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
      });
      continue;
    }

    const good = session as DiscoverySession;
    rounds.push({
      bracketAt,
      deviceImei: imei,
      tagCount: good.total,
      durationSeconds: good.durationSeconds,
      unitBatteryMv,
      readerFw: good.perDeviceFwVersion[imei] ?? null,
      timedOut: false,
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
      });
    }
  }

  store.writeReadings(readings, rounds);
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
export async function ingestDevice(store: Store, config: Config, imei: string, now = new Date()): Promise<IngestResult> {
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
    return { imei, blocksParsed, readingsWritten, from: start, to: now };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    store.finishIngestRun(runId, 'error', { blocksParsed: 0, readingsWritten: 0 }, message);
    store.markDeviceIngest(imei, Date.now(), `error: ${message.slice(0, 200)}`);
    throw err;
  }
}
