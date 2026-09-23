import { JHB_OFFSET_MS, type DeviceRow } from '@tagexplore/core';
import type { Config } from '../config.js';
import type { Store } from '../db/index.js';
import type { LiveBus } from '../events/bus.js';
import { inferDeviceIdentities } from '../infer/identity.js';
import { ingestDevice } from './ingest.js';
import { fetchDeviceSchedule } from './farmrangerClient.js';
import { pollDevicePosition } from './position.js';

/**
 * Polling follows each device's own daily report schedule, read from the
 * settings API: `reportCountPerDay` reports a day, the first at
 * `reportStartMinute` past local midnight and each one
 * `reportIntervalMinutes` after the last. Each report's log is read
 * `pollOffsetMinutes` later, because the upload lands a little after the
 * report itself.
 *
 * The fleet's current setting is 19 hourly reports from 04:10 — 04:10, 05:10,
 * … 22:10 — so with the default 10-minute offset the logs are read at 04:20,
 * 05:20, … 22:20, and the device is left alone overnight.
 *
 * Times are computed against Johannesburg wall-clock, because that is the clock
 * the settings describe (the units report `timezoneAdjust: 7200`) and the
 * server's own timezone is not it.
 *
 * All of this describes *scraping* a device's syslog. A device that posts its
 * campaigns to us has nothing to schedule — see `effectiveIngestMode`.
 */
export function mostRecentDuePollAt(device: DeviceRow, nowMs: number): number {
  const interval = Math.max(1, device.reportIntervalMinutes) * 60_000;
  const count = Math.max(1, device.reportCountPerDay);

  const local = nowMs + JHB_OFFSET_MS;
  const midnight = Math.floor(local / 86_400_000) * 86_400_000;
  const firstPoll = midnight + (device.reportStartMinute + device.pollOffsetMinutes) * 60_000;

  // Before today's first slot, the most recent one is the last of yesterday's
  // series — which is what stops an overnight restart from thinking the device
  // is not due and skipping the log from last night's final report.
  if (local < firstPoll) {
    return firstPoll - 86_400_000 + (count - 1) * interval - JHB_OFFSET_MS;
  }

  // Clamped to the last slot of the day: past it, the device has stopped
  // reporting until tomorrow, so the newest due poll stays that final one.
  const step = Math.min(Math.floor((local - firstPoll) / interval), count - 1);
  return firstPoll + step * interval - JHB_OFFSET_MS;
}

/** True when this device's newest scheduled poll has not been run yet. */
export function isDue(device: DeviceRow, nowMs: number): boolean {
  if (!device.active) return false;
  if (device.lastIngestAt === null) return true;
  return device.lastIngestAt < mostRecentDuePollAt(device, nowMs);
}

/**
 * What `devices.ingest_mode` actually resolves to right now.
 *
 * An explicit setting always wins — an admin who has pinned a unit knows
 * something the data doesn't say, and a firmware regression must not be able
 * to quietly restart an hourly logs-API pull against their wishes.
 *
 * `'auto'` decides from whether the unit has pushed inside the grace period,
 * which is what lets a fleet migrate to push ingest with nobody visiting each
 * device, and what makes a unit whose modem goes quiet fall back to scraping
 * on its own. Because a fallback scrape starts from the device's newest stored
 * bracket less the configured overlap, that first scrape also backfills
 * whatever the silence cost.
 *
 * Kept a pure function of its arguments so the thresholds can be tested
 * without a database or a clock.
 */
export function effectiveIngestMode(
  device: DeviceRow,
  lastPushAt: number | null,
  nowMs: number,
  pushGraceMs: number,
): 'push' | 'scrape' {
  if (device.ingestMode === 'push') return 'push';
  if (device.ingestMode === 'scrape') return 'scrape';
  return lastPushAt !== null && nowMs - lastPushAt <= pushGraceMs ? 'push' : 'scrape';
}

export interface Scheduler {
  /** Runs every device that is due right now. Safe to call at any time. */
  tick(now?: Date): Promise<void>;
  /**
   * Called when a campaign lands for this reader. Reads its position straight
   * away — debounced, and sharing the periodic poll's own clock — so the fix
   * shown beside brand-new readings is from the same few minutes they are.
   */
  notifyPush(imei: string): Promise<void>;
  start(): void;
  stop(): void;
}

/** How often the scheduler wakes to check which devices are due. */
const TICK_MS = 60_000;
/** How often a device's own schedule is re-read from the settings API. */
const SCHEDULE_REFRESH_MS = 6 * 3_600_000;

export function createScheduler(store: Store, config: Config, bus?: LiveBus): Scheduler {
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  const scheduleCheckedAt = new Map<string, number>();
  // Shared between the periodic position pass and the push trigger, so a unit
  // posting three campaigns in a burst makes one events-API call and a push
  // doesn't reset the periodic clock twice.
  const positionCheckedAt = new Map<string, number>();
  const identityCheckedAt = new Map<string, number>();
  // Only logged when it changes, so a device sitting on the scraped path
  // doesn't repeat the same line every minute.
  const lastLoggedMode = new Map<string, 'push' | 'scrape'>();

  async function refreshSchedule(imei: string, nowMs: number): Promise<void> {
    if (!config.settingsApiBase || !config.settingsApiToken) return;
    const last = scheduleCheckedAt.get(imei) ?? 0;
    if (nowMs - last < SCHEDULE_REFRESH_MS) return;
    scheduleCheckedAt.set(imei, nowMs);
    try {
      const schedule = await fetchDeviceSchedule(config, imei);
      if (schedule) store.updateDevice(imei, schedule);
    } catch (err) {
      // A settings API that is down must not stop the log ingest — the stored
      // schedule is still good enough to keep polling on.
      console.error(`[${imei}] schedule refresh failed:`, err instanceof Error ? err.message : err);
    }
  }

  /** Both callers go through here, which is what makes the debounce shared. */
  async function pollPositionIfDue(imei: string, nowMs: number, windowMs: number): Promise<void> {
    const last = positionCheckedAt.get(imei) ?? 0;
    if (nowMs - last < windowMs) return;
    positionCheckedAt.set(imei, nowMs);
    await pollDevicePosition(store, config, bus, imei);
  }

  async function inferIdentitiesIfDue(device: DeviceRow, nowMs: number): Promise<void> {
    const interval = config.inferenceIntervalMinutes * 60_000;
    // The stored value is the restart guard: without it, every device in the
    // fleet would re-infer at once on the first tick after a deploy.
    const last = identityCheckedAt.get(device.imei) ?? device.identityCheckedAt ?? 0;
    if (nowMs - last < interval) return;
    identityCheckedAt.set(device.imei, nowMs);
    try {
      inferDeviceIdentities(store, config, device, nowMs);
    } catch (err) {
      // Same tolerance as the schedule refresh: a guess that failed to be made
      // must not fail the ingest that actually carries the data.
      console.error(`[${device.imei}] identity inference failed:`, err instanceof Error ? err.message : err);
    }
  }

  async function tick(now = new Date()): Promise<void> {
    // Overlapping ticks would double-fetch and fight over the same rows; a slow
    // API call simply means this minute's tick is skipped.
    if (running) return;
    running = true;
    try {
      const nowMs = now.getTime();
      const positionWindowMs = config.positionPollMinutes * 60_000;
      const pushGraceMs = config.pushGraceMinutes * 60_000;

      for (const device of store.listDevices()) {
        if (!device.active) continue;

        // Pass one: the reader's own position and geofences, for every active
        // device however its readings arrive. This is the only thing that
        // moves the purple marker, so it must not be conditional on scraping.
        await pollPositionIfDue(device.imei, nowMs, positionWindowMs);

        const mode = effectiveIngestMode(device, device.lastPushAt, nowMs, pushGraceMs);
        if (lastLoggedMode.get(device.imei) !== mode) {
          if (lastLoggedMode.has(device.imei)) {
            console.log(`[${device.imei}] ingest mode is now ${mode} (setting: ${device.ingestMode})`);
          }
          lastLoggedMode.set(device.imei, mode);
        }

        await inferIdentitiesIfDue(device, nowMs);

        // Pass two: the log scrape. A pushing device skips its schedule
        // refresh too — those four numbers exist only to time a scrape, so
        // re-reading them every six hours for a unit that is never scraped is
        // a settings-API call bought for nothing.
        if (mode === 'push') continue;

        await refreshSchedule(device.imei, nowMs);
        // Re-read after the refresh, in case it moved this device's slots.
        const current = store.getDevice(device.imei) ?? device;
        if (!isDue(current, nowMs)) continue;
        try {
          const result = await ingestDevice(store, config, current.imei, now, bus);
          console.log(
            `[${current.imei}] ingested ${result.readingsWritten} readings from ${result.blocksParsed} blocks`,
          );
        } catch (err) {
          console.error(`[${current.imei}] ingest failed:`, err instanceof Error ? err.message : err);
        }
      }
    } finally {
      running = false;
    }
  }

  return {
    tick,

    async notifyPush(imei: string): Promise<void> {
      await pollPositionIfDue(imei, Date.now(), config.positionPollOnPushMinutes * 60_000);
    },

    start(): void {
      if (timer) return;
      timer = setInterval(() => void tick(), TICK_MS);
      timer.unref();
      // Catch up on anything missed while the process was down, without making
      // startup wait for the network.
      void tick();
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
