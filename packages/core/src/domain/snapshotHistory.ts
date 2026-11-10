import type { LinkReading, TagSnapshot } from '../apiTypes.js';

/**
 * Browsing a past discovery round without asking the server each time.
 *
 * The server sends, once, every whitelisted tag's state just before the
 * window (`base`, the same snapshot the map shows live, taken as of `from`)
 * plus every raw reading inside the window. `snapshotsAt` then rolls those
 * readings forward to any round in the window and gives back what
 * `/api/snapshots?to=<round>` would have: the same snapshots, the same link
 * readings. Clicking a recent round in the count history is then instant.
 *
 * Two small, deliberate differences from the server's own query, both only
 * on fields the map doesn't use for drawing: `readingCount` keeps counting
 * from the window's start instead of a sliding year, and where two readers
 * disagree on the very same round the tie can break the other way.
 */
export interface HistoryReading {
  bracketAt: number;
  deviceImei: string;
  tagId: string;
  batteryMv: number | null;
  rssi: number | null;
  hops: number | null;
  waveCount: number | null;
  movementState: number | null;
  lat: number | null;
  lon: number | null;
  hasGps: boolean;
  fwVersionPatch: number | null;
  gpsAgeSeconds: number | null;
  linkId: string | null;
}

export interface SnapshotHistory {
  /** `base` is every tag's state as of this time; `readings` are strictly after it. */
  from: number;
  /** The newest time the readings cover. A round after this needs a fresh copy. */
  to: number;
  base: TagSnapshot[];
  /** Ascending by `bracketAt`. */
  readings: HistoryReading[];
  /** Labels for tags that appear only in `readings`. */
  labels: Record<string, string | null>;
}

interface TagState {
  snap: TagSnapshot;
  lastNotStillAt: number;
  stillStart: number | null;
  lastCountedBracket: number;
}

export function snapshotsAt(history: SnapshotHistory, at: number): { snapshots: TagSnapshot[]; links: LinkReading[] } {
  const state = new Map<string, TagState>();
  for (const s of history.base) {
    const still = s.movementState === 1;
    state.set(s.tagId, {
      snap: { ...s },
      lastNotStillAt: still ? (s.stillSince ?? s.lastSeenAt) - 1 : s.lastSeenAt,
      stillStart: still ? (s.stillSince ?? s.lastSeenAt) : null,
      lastCountedBracket: s.lastSeenAt,
    });
  }

  let linkBracket: number | null = null;
  for (const r of history.readings) {
    if (r.bracketAt > at) break;
    linkBracket = r.bracketAt;
    let st = state.get(r.tagId);
    if (!st) {
      st = {
        snap: {
          tagId: r.tagId,
          label: history.labels[r.tagId] ?? null,
          lastSeenAt: -Infinity,
          batteryMv: null,
          rssi: null,
          hops: null,
          waveCount: null,
          movementState: null,
          fwVersionPatch: null,
          linkId: null,
          sourceDeviceImei: r.deviceImei,
          lat: null,
          lon: null,
          fixAt: null,
          gpsAgeSeconds: null,
          readingCount: 0,
          stillSince: null,
        },
        lastNotStillAt: -Infinity,
        stillStart: null,
        lastCountedBracket: -Infinity,
      };
      state.set(r.tagId, st);
    }
    const s = st.snap;
    if (r.bracketAt >= s.lastSeenAt) {
      s.lastSeenAt = r.bracketAt;
      s.batteryMv = r.batteryMv;
      s.rssi = r.rssi;
      s.hops = r.hops;
      s.waveCount = r.waveCount;
      s.movementState = r.movementState;
      s.fwVersionPatch = r.fwVersionPatch;
      s.linkId = r.linkId;
      s.sourceDeviceImei = r.deviceImei;
    }
    if (r.hasGps && r.bracketAt >= (s.fixAt ?? -Infinity)) {
      s.lat = r.lat;
      s.lon = r.lon;
      s.fixAt = r.bracketAt;
      s.gpsAgeSeconds = r.gpsAgeSeconds;
    }
    if (r.bracketAt !== st.lastCountedBracket) {
      s.readingCount += 1;
      st.lastCountedBracket = r.bracketAt;
    }
    // The current still streak: still readings after the last one that wasn't.
    if (r.movementState !== 1) {
      st.lastNotStillAt = r.bracketAt;
      st.stillStart = null;
    } else if (r.bracketAt > st.lastNotStillAt && st.stillStart === null) {
      st.stillStart = r.bracketAt;
    }
  }

  const snapshots = [...state.values()].map((st) => ({
    ...st.snap,
    stillSince: st.snap.movementState === 1 ? (st.stillStart ?? st.snap.lastSeenAt) : null,
  }));
  snapshots.sort((a, b) => b.lastSeenAt - a.lastSeenAt || a.tagId.localeCompare(b.tagId));

  const links: LinkReading[] =
    linkBracket === null
      ? []
      : history.readings
          .filter((r) => r.bracketAt === linkBracket)
          .map((r) => ({ tagId: r.tagId, sourceDeviceImei: r.deviceImei, linkId: r.linkId, waveCount: r.waveCount }));

  return { snapshots, links };
}
