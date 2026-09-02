import { JHB_OFFSET_MS, type DeviceRow } from '@tagexplore/core';
import type { Config } from '../config.js';
import type { Store } from '../db/index.js';
import { ingestDevice } from './ingest.js';
import { fetchDeviceSchedule } from './farmrangerClient.js';

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

export interface Scheduler {
  /** Runs every device that is due right now. Safe to call at any time. */
  tick(now?: Date): Promise<void>;
  start(): void;
  stop(): void;
}

/** How often the scheduler wakes to check which devices are due. */
const TICK_MS = 60_000;
/** How often a device's own schedule is re-read from the settings API. */
const SCHEDULE_REFRESH_MS = 6 * 3_600_000;

export function createScheduler(store: Store, config: Config): Scheduler {
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  const scheduleCheckedAt = new Map<string, number>();

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

  async function tick(now = new Date()): Promise<void> {
    // Overlapping ticks would double-fetch and fight over the same rows; a slow
    // API call simply means this minute's tick is skipped.
    if (running) return;
    running = true;
    try {
      const nowMs = now.getTime();
      for (const device of store.listDevices()) {
        if (!device.active) continue;
        await refreshSchedule(device.imei, nowMs);
        // Re-read after the refresh, in case it moved this device's slots.
        const current = store.getDevice(device.imei) ?? device;
        if (!isDue(current, nowMs)) continue;
        try {
          const result = await ingestDevice(store, config, current.imei, now);
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
