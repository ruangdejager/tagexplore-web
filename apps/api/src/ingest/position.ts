/**
 * The reader's own position, and the geofences that ride the same request.
 *
 * Neither is in the discovery data at all — not in a scraped log block, not in
 * a pushed CBOR campaign — so both are read off the FarmRanger events API. This
 * used to happen as a tail step of a log ingest, which tied the purple marker's
 * freshness to the log-scrape schedule and meant a reader that only ever pushed
 * would have its marker frozen wherever it was first seen. It is now its own
 * thing on its own cadence, driven by the scheduler.
 *
 * Best-effort throughout, same as it was inside the ingest: no settings token,
 * an events API that is down, a reader with no fix yet — none of those are
 * failures worth propagating, because nothing else depends on the answer.
 */

import type { Config } from '../config.js';
import type { Store } from '../db/index.js';
import type { LiveBus } from '../events/bus.js';
import { fetchDeviceEventData } from './farmrangerClient.js';

export interface PositionPollResult {
  positionWritten: boolean;
  geofencesWritten: number;
}

/**
 * Reads one reader's newest event and stores what it carries. Never throws:
 * the caller is a scheduler tick or a fire-and-forget push hook, and neither
 * has anything useful to do with the failure.
 */
export async function pollDevicePosition(
  store: Store,
  config: Config,
  bus: LiveBus | undefined,
  imei: string,
): Promise<PositionPollResult> {
  const result: PositionPollResult = { positionWritten: false, geofencesWritten: 0 };

  try {
    const device = store.getDevice(imei);
    if (!device) return result;

    const { position, geofences } = await fetchDeviceEventData(config, imei);

    if (position) {
      store.setDevicePosition(imei, position.lat, position.lon, position.reportedAt);
      result.positionWritten = true;
      bus?.publish({ type: 'device-position', orgId: device.orgId, imei, at: Date.now() });
    }

    if (geofences.length > 0) {
      store.upsertGeofences(device.orgId, geofences);
      result.geofencesWritten = geofences.length;
      bus?.publish({ type: 'geofences', orgId: device.orgId, imei, at: Date.now() });
    }
  } catch (err) {
    // Logged rather than silent, unlike the old inline version: this is now the
    // only thing that moves a reader's marker, so a reader stuck in one place
    // should leave a trace of why.
    console.error(`[${imei}] position read failed:`, err instanceof Error ? err.message : err);
  }

  return result;
}
