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
 *   - inside a geofence: that one (the smallest, where geofences overlap);
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
  /** The geofence the tag is counted in, or null when it was left out (see `reason`). */
  regionId: string | null;
  position: ResolvedTagPosition | null;
  /** Metres outside the chosen (or nearest) geofence; 0 when inside. */
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

/** Area in square metres — only used to prefer the smaller of two overlapping geofences. */
function areaSquareMeters(coordinates: LatLon[]): number {
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
    .map((g) => ({ id: g.regionId, coords: g.coordinates, area: areaSquareMeters(g.coordinates) }));
  const readers = new Map(devices.map((d) => [d.imei, d]));
  const latestRound = window === 'latest' ? checkedInTagIds(snapshots, 'latest', nowMs) : new Set<string>();
  const out = new Map<string, TagGeofenceAllocation>();

  for (const snap of snapshots) {
    const position = resolveTagPosition(snap, readers.get(snap.sourceDeviceImei), fixInWindow(snap, window, nowMs, latestRound));
    const base = { tagId: snap.tagId, position };
    if (!position) {
      out.set(snap.tagId, { ...base, regionId: null, outsideMeters: 0, reason: 'no-position' });
      continue;
    }
    if (fences.length === 0) {
      out.set(snap.tagId, { ...base, regionId: null, outsideMeters: 0, reason: 'no-geofences' });
      continue;
    }
    const point: LatLon = [position.lat, position.lon];
    let inside: (typeof fences)[number] | null = null;
    for (const f of fences) {
      if (pointInGeofence(point, f.coords) && (!inside || f.area < inside.area)) inside = f;
    }
    if (inside) {
      out.set(snap.tagId, { ...base, regionId: inside.id, outsideMeters: 0, reason: 'inside' });
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
      out.set(snap.tagId, { ...base, regionId: null, outsideMeters: nearestM, reason: 'outside' });
    } else {
      out.set(snap.tagId, { ...base, regionId: nearest.id, outsideMeters: nearestM, reason: 'nearest' });
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
    const regionId = allocations.get(tagId)?.regionId;
    if (regionId != null) counts.set(regionId, (counts.get(regionId) ?? 0) + 1);
  }
  return counts;
}
