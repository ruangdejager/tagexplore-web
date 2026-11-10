import type { DeviceRow, GeofenceRegion, TagSnapshot } from '../apiTypes.js';
import { checkedInTagIds, type DiscoveryWindow } from './discoveryWindow.js';

/**
 * Which geofence each tag belongs to — worked out automatically, never
 * assigned by hand. Shared by the desktop and mobile maps so both put every
 * tag in the same geofence.
 *
 * The position a tag is judged at, in order:
 *
 *   1. `tag-gps` — the tag's own GPS fix, taken inside the count's window
 *      (for "Latest": in the latest round itself; for "Last 6h": within 6h).
 *   2. `reader` — the position of the reader that reported the tag, when that
 *      position applies to the discovery being shown (`own` or `linked-tag`).
 *   3. `tag-last-gps` / `reader-last` — neither of the above, so the newest
 *      position on record from either the tag's own fix or that reader.
 *
 * Then:
 *   - inside one or more geofences: every one of them — where geofences
 *     overlap, a tag inside both counts in both;
 *   - outside every geofence, and the position is the tag's *own* GPS at
 *     least `GEOFENCE_EXCLUDE_METERS` from the nearest one: in no geofence;
 *   - otherwise: the nearest geofence.
 *
 * A tag with no position at all, from either source, can't be placed.
 */
export const GEOFENCE_EXCLUDE_METERS = 50;

export type GeofencePositionSource = 'tag-gps' | 'reader' | 'tag-last-gps' | 'reader-last';

export interface ResolvedTagPosition {
  lat: number;
  lon: number;
  source: GeofencePositionSource;
  /** When that position was reported, if known. */
  at: number | null;
}

export interface TagGeofenceAllocation {
  tagId: string;
  /**
   * Every geofence the tag is counted in: all the ones it is inside, or just
   * the nearest one. Empty when it was left out (see `reason`).
   */
  regionIds: string[];
  position: ResolvedTagPosition | null;
  /** Metres outside the nearest geofence; 0 when inside. */
  outsideMeters: number;
  reason: 'inside' | 'nearest' | 'outside' | 'no-position' | 'no-geofences';
}

type LatLon = [number, number];

const M_PER_DEG_LAT = 110_540;
const M_PER_DEG_LON_EQUATOR = 111_320;

/** Flat-earth projection to metres around `origin` — accurate well past farm scale. */
function project(origin: LatLon, p: LatLon): [number, number] {
  const cos = Math.cos((origin[0] * Math.PI) / 180);
  return [(p[1] - origin[1]) * M_PER_DEG_LON_EQUATOR * cos, (p[0] - origin[0]) * M_PER_DEG_LAT];
}

/** Ray-casting point-in-polygon on `[lat, lon]` vertices; the closing edge is implied. */
export function pointInGeofence(point: LatLon, coordinates: LatLon[]): boolean {
  if (coordinates.length < 3) return false;
  const [y, x] = point;
  let inside = false;
  for (let i = 0, j = coordinates.length - 1; i < coordinates.length; j = i++) {
    const [yi, xi] = coordinates[i]!;
    const [yj, xj] = coordinates[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Shortest distance in metres from `point` to the polygon's boundary. */
export function distanceToGeofenceEdge(point: LatLon, coordinates: LatLon[]): number {
  if (coordinates.length === 0) return Infinity;
  let best = Infinity;
  for (let i = 0, j = coordinates.length - 1; i < coordinates.length; j = i++) {
    const [ax, ay] = project(point, coordinates[j]!);
    const [bx, by] = project(point, coordinates[i]!);
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    // The point is the origin, so project (0,0) onto segment a→b.
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    if (d < best) best = d;
  }
  return best;
}

/** Area in square metres. */
export function geofenceAreaSquareMeters(coordinates: LatLon[]): number {
  if (coordinates.length < 3) return 0;
  const origin = coordinates[0]!;
  let sum = 0;
  for (let i = 0, j = coordinates.length - 1; i < coordinates.length; j = i++) {
    const [xj, yj] = project(origin, coordinates[j]!);
    const [xi, yi] = project(origin, coordinates[i]!);
    sum += xj * yi - xi * yj;
  }
  return Math.abs(sum) / 2;
}

/**
 * Where a geofence's count bubble sits: the polygon's area centroid, or the
 * vertex average for a degenerate one.
 */
export function geofenceCentroid(coordinates: LatLon[]): LatLon | null {
  if (coordinates.length === 0) return null;
  const origin = coordinates[0]!;
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = coordinates.length - 1; i < coordinates.length; j = i++) {
    const [xj, yj] = project(origin, coordinates[j]!);
    const [xi, yi] = project(origin, coordinates[i]!);
    const cross = xj * yi - xi * yj;
    a += cross;
    cx += (xj + xi) * cross;
    cy += (yj + yi) * cross;
  }
  if (Math.abs(a) < 1e-6) {
    const lat = coordinates.reduce((s, c) => s + c[0], 0) / coordinates.length;
    const lon = coordinates.reduce((s, c) => s + c[1], 0) / coordinates.length;
    return [lat, lon];
  }
  cx /= 3 * a;
  cy /= 3 * a;
  const cos = Math.cos((origin[0] * Math.PI) / 180);
  return [origin[0] + cy / M_PER_DEG_LAT, origin[1] + cx / (M_PER_DEG_LON_EQUATOR * cos)];
}

/**
 * Where a geofence's count bubble goes: the centroid when that is inside the
 * shape, otherwise a point guaranteed inside it — the middle of the widest
 * stretch of the shape along a few horizontal lines through it. A C- or
 * L-shaped geofence has its centroid outside; this pulls the bubble back in.
 */
export function geofenceLabelPoint(coordinates: LatLon[]): LatLon | null {
  const centroid = geofenceCentroid(coordinates);
  if (!centroid || coordinates.length < 3 || pointInGeofence(centroid, coordinates)) return centroid;
  const lats = coordinates.map((c) => c[0]);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  let best: { point: LatLon; width: number } | null = null;
  const STEPS = 24;
  for (let k = 0; k < STEPS; k++) {
    // Half-steps, so a scan line never runs exactly along a horizontal edge.
    const lat = minLat + ((maxLat - minLat) * (k + 0.5)) / STEPS;
    const xs: number[] = [];
    for (let i = 0, j = coordinates.length - 1; i < coordinates.length; j = i++) {
      const [yi, xi] = coordinates[i]!;
      const [yj, xj] = coordinates[j]!;
      if (yi > lat !== yj > lat) xs.push(xi + ((lat - yi) * (xj - xi)) / (yj - yi));
    }
    xs.sort((a, b) => a - b);
    for (let m = 0; m + 1 < xs.length; m += 2) {
      const width = xs[m + 1]! - xs[m]!;
      // Lines nearer the centroid's own latitude win ties, so the bubble stays
      // as central as the shape allows.
      const score = width / (1 + Math.abs(lat - centroid[0]) / (maxLat - minLat || 1));
      if (!best || score > best.width) best = { point: [lat, (xs[m]! + xs[m + 1]!) / 2], width: score };
    }
  }
  return best?.point ?? centroid;
}

/**
 * Whether the tag's own fix counts as current for the count's window — the
 * same rule the desktop's "GPS state" legend uses.
 */
function fixInWindow(snap: TagSnapshot, window: DiscoveryWindow, nowMs: number, latestRound: Set<string>): boolean {
  if (snap.fixAt === null || snap.lat === null || snap.lon === null) return false;
  if (window === 'latest') return latestRound.has(snap.tagId) && snap.fixAt >= snap.lastSeenAt;
  return snap.fixAt >= nowMs - Number(window) * 3_600_000;
}

type ReaderPosition = Pick<DeviceRow, 'imei' | 'lat' | 'lon' | 'positionSource' | 'positionAt' | 'gpsUpdatedAt'>;

/** The position a tag is judged at — see the module comment for the order. */
export function resolveTagPosition(
  snap: TagSnapshot,
  reader: ReaderPosition | undefined,
  fixIsCurrent: boolean,
): ResolvedTagPosition | null {
  if (fixIsCurrent && snap.lat !== null && snap.lon !== null) {
    return { lat: snap.lat, lon: snap.lon, source: 'tag-gps', at: snap.fixAt };
  }
  const readerHasPos = reader !== undefined && reader.lat !== null && reader.lon !== null;
  if (readerHasPos && (reader.positionSource === 'own' || reader.positionSource === 'linked-tag')) {
    return { lat: reader.lat!, lon: reader.lon!, source: 'reader', at: reader.positionAt ?? reader.gpsUpdatedAt };
  }
  const tagLast: ResolvedTagPosition | null =
    snap.lat !== null && snap.lon !== null ? { lat: snap.lat, lon: snap.lon, source: 'tag-last-gps', at: snap.fixAt } : null;
  const readerLast: ResolvedTagPosition | null = readerHasPos
    ? { lat: reader.lat!, lon: reader.lon!, source: 'reader-last', at: reader.positionAt ?? reader.gpsUpdatedAt }
    : null;
  if (tagLast && readerLast) return (readerLast.at ?? -Infinity) > (tagLast.at ?? -Infinity) ? readerLast : tagLast;
  return tagLast ?? readerLast;
}

/** Allocates every tag in `snapshots` to a geofence. */
export function allocateTagsToGeofences(
  snapshots: TagSnapshot[],
  devices: ReaderPosition[],
  geofences: GeofenceRegion[],
  window: DiscoveryWindow,
  nowMs: number,
): Map<string, TagGeofenceAllocation> {
  const fences = geofences
    .filter((g) => g.coordinates.length >= 3)
    .map((g) => ({ id: g.regionId, coords: g.coordinates }));
  const readers = new Map(devices.map((d) => [d.imei, d]));
  const latestRound = window === 'latest' ? checkedInTagIds(snapshots, 'latest', nowMs) : new Set<string>();
  const out = new Map<string, TagGeofenceAllocation>();

  for (const snap of snapshots) {
    const position = resolveTagPosition(snap, readers.get(snap.sourceDeviceImei), fixInWindow(snap, window, nowMs, latestRound));
    const base = { tagId: snap.tagId, position };
    if (!position) {
      out.set(snap.tagId, { ...base, regionIds: [], outsideMeters: 0, reason: 'no-position' });
      continue;
    }
    if (fences.length === 0) {
      out.set(snap.tagId, { ...base, regionIds: [], outsideMeters: 0, reason: 'no-geofences' });
      continue;
    }
    const point: LatLon = [position.lat, position.lon];
    const inside = fences.filter((f) => pointInGeofence(point, f.coords)).map((f) => f.id);
    if (inside.length > 0) {
      out.set(snap.tagId, { ...base, regionIds: inside, outsideMeters: 0, reason: 'inside' });
      continue;
    }
    let nearest = fences[0]!;
    let nearestM = Infinity;
    for (const f of fences) {
      const d = distanceToGeofenceEdge(point, f.coords);
      if (d < nearestM) {
        nearestM = d;
        nearest = f;
      }
    }
    const ownGps = position.source === 'tag-gps' || position.source === 'tag-last-gps';
    if (ownGps && nearestM >= GEOFENCE_EXCLUDE_METERS) {
      out.set(snap.tagId, { ...base, regionIds: [], outsideMeters: nearestM, reason: 'outside' });
    } else {
      out.set(snap.tagId, { ...base, regionIds: [nearest.id], outsideMeters: nearestM, reason: 'nearest' });
    }
  }
  return out;
}

/** How many of `countedTagIds` fall in each geofence. Every geofence gets an entry, 0 included. */
export function geofenceTagCounts(
  allocations: Map<string, TagGeofenceAllocation>,
  geofences: GeofenceRegion[],
  countedTagIds: Set<string>,
): Map<string, number> {
  const counts = new Map(geofences.map((g) => [g.regionId, 0]));
  for (const tagId of countedTagIds) {
    for (const regionId of allocations.get(tagId)?.regionIds ?? []) counts.set(regionId, (counts.get(regionId) ?? 0) + 1);
  }
  return counts;
}

/** What a geofence's info box says about the tags placed in it. */
export interface GeofenceStats {
  regionId: string;
  /** Counted tags (the count's own set) placed in this geofence — the bubble's number. */
  counted: number;
  /** Every tag placed in it, counted in the window or not. */
  placed: number;
  /** Placed because their position is inside it. */
  inside: number;
  /** Placed here as the nearest geofence, from just outside. */
  nearest: number;
  /** Judged at the tag's own GPS (current or last known). */
  byTagGps: number;
  /** Judged at the reporting reader's position. */
  byReader: number;
  /** Also counted in another, overlapping geofence. */
  shared: number;
  /** The tag ids placed here, for highlighting them on the map. */
  tagIds: Set<string>;
}

export function geofenceStats(
  allocations: Map<string, TagGeofenceAllocation>,
  geofences: GeofenceRegion[],
  countedTagIds: Set<string>,
): Map<string, GeofenceStats> {
  const out = new Map<string, GeofenceStats>(
    geofences.map((g) => [
      g.regionId,
      { regionId: g.regionId, counted: 0, placed: 0, inside: 0, nearest: 0, byTagGps: 0, byReader: 0, shared: 0, tagIds: new Set() },
    ]),
  );
  for (const a of allocations.values()) {
    for (const regionId of a.regionIds) {
      const s = out.get(regionId);
      if (!s) continue;
      s.placed += 1;
      s.tagIds.add(a.tagId);
      if (countedTagIds.has(a.tagId)) s.counted += 1;
      if (a.reason === 'inside') s.inside += 1;
      else s.nearest += 1;
      if (a.position?.source === 'tag-gps' || a.position?.source === 'tag-last-gps') s.byTagGps += 1;
      else s.byReader += 1;
      if (a.regionIds.length > 1) s.shared += 1;
    }
  }
  return out;
}
