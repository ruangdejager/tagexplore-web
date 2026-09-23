/**
 * Deciding which position to show for a reader, and whether it actually
 * applies to the discovery being looked at.
 *
 * A reader's GPS fix is cached whenever its events feed is read, on its own
 * cadence — which has nothing to do with when its discovery rounds happen. So
 * a fix can easily be hours away from the round on screen, and showing it as
 * though it were that round's position is simply wrong. The rule is that a fix
 * counts only if it was reported close enough in time to the discovery;
 * otherwise the reader is shown greyed, and the one genuinely better answer is
 * tried first: the ordinary tag carried by the same animal, whose own position
 * for that exact round is as good as the reader's own would have been.
 */

import type { DeviceRow } from '@tagexplore/core';
import type { Config } from '../config.js';
import type { Store } from '../db/index.js';

/**
 * What a reader's position is judged against, and how much slack that moment
 * carries.
 *
 * A pushed round knows exactly when it reached the server, so it gets the
 * configured window and nothing more. A scraped round knows only the
 * 15-minute bracket its blocks were bucketed into — its true time is anywhere
 * within half a bracket of that — so the uncertainty is added explicitly
 * rather than papered over by treating the bracket as exact.
 */
export function judgementTime(
  config: Config,
  round: { bracketAt: number; receivedAt: number | null },
): { at: number; windowMs: number } {
  const base = config.devicePositionWindowMinutes * 60_000;
  if (round.receivedAt !== null) return { at: round.receivedAt, windowMs: base };
  const slack = config.devicePositionBracketSlack ? (config.bracketMinutes * 60_000) / 2 : 0;
  return { at: round.bracketAt, windowMs: base + slack };
}

/**
 * Resolves one reader's position for one discovery, walking the chain:
 *
 *   1. its own fix within the window            → `own`
 *   2. its carried tag's fix in that same round → `linked-tag`
 *   3. its last known position                  → `stale`, rendered greyed
 *   4. nothing at all                           → `none`
 *
 * `bracketAt` is the round being browsed, or null for the live view — which
 * judges against the reader's own newest round rather than the wall clock, so
 * that a marker greys out when the cached fix has fallen behind the unit's own
 * reporting, exactly as it would in history.
 *
 * Leg 2 is deliberately strict: the carried tag's fix *in that round*, not its
 * newest fix from somewhere nearby in time. It is standing in for where the
 * reader was during that discovery, and a position from an adjacent round is
 * an answer to a different question.
 */
export function resolveDevicePosition(store: Store, config: Config, device: DeviceRow, bracketAt: number | null): DeviceRow {
  const round = bracketAt === null ? store.latestRoundTimeFor(device.imei) : store.roundTimeFor(device.imei, bracketAt);

  // No round to judge against — a reader registered but never heard from. Its
  // last known position is all there is, and there is nothing to call it
  // applicable to, so it stays whatever `toDeviceRow` defaulted it to.
  if (!round) return device;

  const { at, windowMs } = judgementTime(config, round);

  const own = store.getDevicePositionNear(device.imei, at, windowMs);
  if (own) {
    return {
      ...device,
      lat: own.lat,
      lon: own.lon,
      gpsUpdatedAt: own.reportedAt,
      positionSource: 'own',
      positionAt: own.reportedAt,
      positionTagId: null,
      discoveryAt: at,
    };
  }

  if (device.carriedTagId !== null) {
    const tag = store.tagPositionInBracket(device.orgId, device.carriedTagId, round.bracketAt, device.imei);
    // A tag can report a fix it took long before it transmitted it. Relaying a
    // stale fix through a tag does not make it fresh, so it is held to the same
    // window as the reader's own would have been.
    const tagFixIsFresh = tag !== null && (tag.gpsAgeSeconds === null || tag.gpsAgeSeconds * 1000 <= windowMs);
    if (tag && tagFixIsFresh) {
      return {
        ...device,
        lat: tag.lat,
        lon: tag.lon,
        gpsUpdatedAt: round.bracketAt,
        positionSource: 'linked-tag',
        positionAt: round.bracketAt,
        positionTagId: device.carriedTagId,
        discoveryAt: at,
      };
    }
  }

  // Nothing applicable. Whatever is known is shown, greyed — "the reader is
  // roughly over there" is still worth having, as long as it is not dressed up
  // as current.
  const last = store.getDevicePositionAt(device.imei, at);
  if (last) {
    return {
      ...device,
      lat: last.lat,
      lon: last.lon,
      gpsUpdatedAt: last.reportedAt,
      positionSource: 'stale',
      positionAt: last.reportedAt,
      positionTagId: null,
      discoveryAt: at,
    };
  }

  // Nothing before this moment, but the device row may still carry a later fix
  // (browsing a round from before the reader was ever positioned).
  return {
    ...device,
    positionSource: device.lat === null || device.lon === null ? 'none' : 'stale',
    discoveryAt: at,
  };
}
