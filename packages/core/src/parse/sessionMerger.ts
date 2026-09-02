import { epochToJhb } from '../time.js';
import type { DiscoveryBlock, MergedSession, SessionTag } from '../types.js';

/**
 * Merges discovery blocks from one or more devices into "sessions": a single
 * discovery round that may be split across multiple devices' logs — and, in
 * practice, sometimes split into multiple blocks from the *same* device a few
 * seconds apart (duplicate emission, or a failed attempt followed by a retry).
 *
 * Rather than chaining nearby timestamps, each block's timestamp is rounded to
 * the nearest bracket (default every 15 minutes: 12:00, 12:15, 12:30, ...) and
 * every block whose timestamp rounds to the same bracket — regardless of which
 * device, or how many blocks a single device contributed — is combined into one
 * session. This is safe because actual discovery rounds are hours apart, far
 * wider than the bracket width.
 *
 * A LOG TIMEOUT block is simply excluded from the session, since devices retry
 * and often succeed a few seconds later within the same bracket — only if a
 * bracket has *no* successful block at all (from any device) is the whole
 * session discarded and flagged so the caller can surface it.
 */
export const DEFAULT_BRACKET_MINUTES = 15;

export function mergeSessions(
  blocksByUnit: Record<string, DiscoveryBlock[]>,
  bracketMinutes: number = DEFAULT_BRACKET_MINUTES,
): MergedSession[] {
  const bracketMs = bracketMinutes * 60 * 1000;
  const all = Object.values(blocksByUnit).flat().filter((b) => b.timestamp);

  const buckets = new Map<number, DiscoveryBlock[]>();
  for (const block of all) {
    const epoch = new Date(block.timestamp).getTime();
    const bracketEpoch = Math.round(epoch / bracketMs) * bracketMs;
    const existing = buckets.get(bracketEpoch);
    if (existing) existing.push(block);
    else buckets.set(bracketEpoch, [block]);
  }

  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([bracketEpoch, blocks]) => bucketToSession(bracketEpoch, blocks));
}

function bucketToSession(bracketEpoch: number, blocks: DiscoveryBlock[]): MergedSession {
  const { date, time, iso } = epochToJhb(bracketEpoch);
  const successBlocks = blocks.filter((b) => !b.isTimeout);
  const timeoutBlocks = blocks.filter((b) => b.isTimeout);

  if (successBlocks.length === 0) {
    return {
      timestamp: iso,
      date,
      time,
      discarded: true,
      timeoutUnitIds: [...new Set(timeoutBlocks.map((b) => b.unitId))],
      involvedUnitIds: [...new Set(blocks.map((b) => b.unitId))],
    };
  }

  const tagById = new Map<string, SessionTag>();
  const perDeviceTagIds: Record<string, Set<string>> = {};
  const perDeviceFwVersion: Record<string, string> = {};
  /** Earliest successful block per device, for the duration calculation below. */
  const perDeviceEarliestSuccessMs: Record<string, number> = {};

  for (const block of successBlocks) {
    let seenIds = perDeviceTagIds[block.unitId];
    if (!seenIds) {
      seenIds = new Set<string>();
      perDeviceTagIds[block.unitId] = seenIds;
    }
    if (!perDeviceFwVersion[block.unitId] && block.readerFwVersion) {
      perDeviceFwVersion[block.unitId] = block.readerFwVersion;
    }
    const blockMs = new Date(block.timestamp).getTime();
    const earliest = perDeviceEarliestSuccessMs[block.unitId];
    if (earliest === undefined || blockMs < earliest) {
      perDeviceEarliestSuccessMs[block.unitId] = blockMs;
    }

    for (const tag of block.tags) {
      seenIds.add(tag.id);
      const existing = tagById.get(tag.id);
      if (!existing) {
        tagById.set(tag.id, { ...tag, sourceUnitId: block.unitId });
      } else {
        // Per-scan readings (rssi/battery/etc.) keep whichever device saw the tag
        // first — but fw version and GPS are properties of the tag itself, so
        // backfill them from this block if the first-seen block lacked them.
        if (existing.fwVersionPatch === null && tag.fwVersionPatch !== null) {
          existing.fwVersionPatch = tag.fwVersionPatch;
        }
        if (!existing.hasGps && tag.hasGps) {
          existing.hasGps = true;
          existing.lat = tag.lat;
          existing.lon = tag.lon;
          existing.gpsAgeSeconds = tag.gpsAgeSeconds;
        }
      }
    }
  }

  const perDeviceTotals: Record<string, number> = {};
  for (const [unitId, ids] of Object.entries(perDeviceTagIds)) perDeviceTotals[unitId] = ids.size;

  // Discovery is assumed to start exactly at the bracket boundary; each device's
  // duration is how long after that its earliest successful block landed. Only the
  // slowest device's duration is reported for the round.
  const durations = Object.values(perDeviceEarliestSuccessMs).map((ms) =>
    Math.max(0, Math.round((ms - bracketEpoch) / 1000)),
  );

  return {
    timestamp: iso,
    date,
    time,
    discarded: false,
    involvedUnitIds: [...new Set(successBlocks.map((b) => b.unitId))],
    tags: [...tagById.values()],
    total: tagById.size,
    perDeviceTotals,
    perDeviceFwVersion,
    durationSeconds: durations.length ? Math.max(...durations) : 0,
  };
}
