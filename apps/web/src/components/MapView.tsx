import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import L from 'leaflet';
import 'leaflet.heat';
import {
  AGE_COLOR,
  ageColor,
  checkedInTagIds,
  type DeviceRow,
  type GeofenceRegion,
  type GpsPoint,
  type TagPosition,
  type TagSnapshot,
} from '@tagexplore/core';
import * as api from '../api.js';
import { DEFAULT_ZOOM, SOUTH_AFRICA } from '../mapDefaults.js';
import type { MainView } from './ViewPanel.js';

/** What a marker's fill colour means — picked by clicking one of the three legends. */
export type MarkerColorMode = 'age' | 'latestGps' | 'discovery';

interface Props {
  /** Which of the two views is currently showing — one Leaflet instance serves
   *  both, so switching between them never re-mounts the map, moves it, or
   *  reloads a single tile: only which layer is attached changes. */
  mode: MainView;
  /** The detail card and legend, which sit over the map inside the same box — global mode only. */
  children?: ReactNode;

  // --- Global map ------------------------------------------------------------
  snapshots: TagSnapshot[];
  selectedTagId: string | null;
  onSelect: (tagId: string | null) => void;
  /** Bumped by the parent to re-fit the view to whatever is currently shown. */
  fitNonce: number;
  /** Changes when the underlying set of tags does (a different organisation),
   *  which is when the view should frame itself again without being asked. */
  autoFitKey: string | null;
  /** Density view instead of per-tag markers — the two are mutually exclusive. */
  heatmapView: boolean;
  heatPoints: GpsPoint[];
  colorMode: MarkerColorMode;
  /** Tags counted as "checked in" under the count panel's current window — only read in 'discovery' mode. */
  discoveryIds: Set<string>;
  /** Dotted lines from each tag in the latest discovery to the tag — or the
   *  reader itself — its data actually relayed through. Off by default, and
   *  mutually exclusive with the heatmap (which has no per-tag positions to
   *  connect). */
  linkView: boolean;
  /** The org's readers — plotted as a standout marker wherever one's own
   *  position is known, and matched against a tag's link id (via `radioId`)
   *  to give a direct-to-base link somewhere to point at. */
  devices: DeviceRow[];

  // --- Movement map ------------------------------------------------------------
  orgId: string | null;
  /** Tags currently toggled on in the main list — what the movement map replays,
   *  and what it shows at their current position before a replay is ever loaded. */
  movementSnapshots: TagSnapshot[];

  // --- Shared ------------------------------------------------------------
  /** Every org tag's own latest position, regardless of the list's toggles — what "Recentre" frames to. */
  orgPoints: Array<[number, number]>;
  /** Geofence boundaries, read off the readers' own events feed — available in
   *  both views, since a property boundary is useful context in either. */
  geofences: GeofenceRegion[];
  geofencesView: boolean;
}

/** True when the tag's most recent reading — not just some earlier one — carried a GPS fix. */
function hasFreshGps(tag: TagSnapshot): boolean {
  return tag.fixAt !== null && tag.fixAt === tag.lastSeenAt;
}

/**
 * Esri's imagery thins out over rural South Africa in places — past a point
 * you get "map data not yet available" tiles instead of a picture. Both
 * layers are allowed to zoom the same distance in regardless: where the
 * imagery genuinely runs out, the existing tile-error fallback already
 * switches to the vector layer, which has coverage this deep everywhere.
 */
const MAX_ZOOM = { Satellite: 19, Terrain: 19 } as const;
type BaseName = keyof typeof MAX_ZOOM;

/**
 * Tuned so a handful of nearby fixes only ever look faint, and it takes a real
 * cluster to reach red — not two or three overlapping points. `radius` is kept
 * small for fine spatial resolution (a coarse blob hides exactly the density
 * differences this view exists to show); `max` is the density level mapped to
 * full intensity, and is set well above what a lightly-visited spot reaches, so
 * only genuinely dense areas climb the gradient toward red.
 */
const HEATMAP_OPTIONS: L.HeatMapOptions = { radius: 12, blur: 10, max: 14, minOpacity: 0.08 };

/** Colour for a link line and its arrow — the same green the app already uses for "live"/"checked in". */
const LINK_COLOR = '#4FBF8B';
const MOVEMENT_GREEN = '#4FBF8B';
/** Purple, and distinct from every tag colour on the map, so the reader itself is unmistakable. */
const DEVICE_COLOR = '#A855F7';

const MOVEMENT_DAY_MS = 86_400_000;
const MOVEMENT_SPEEDS = [1, 2, 4, 8, 16] as const;
/** Wall-clock ms between animation frames at 1×. */
const MOVEMENT_FRAME_INTERVAL_MS = 500;

// Bigger than a tag's own marker (14px across, including its border) so the
// reader unmistakably stands out as the one fixed landmark on the map.
const DEVICE_ICON_SIZE = 26;
const DEVICE_DOT_SIZE = 18;

function deviceIcon(): L.DivIcon {
  return L.divIcon({
    className: 'device-marker-wrap',
    html: '<span class="device-marker-ping"></span><span class="device-marker-dot"></span>',
    iconSize: [DEVICE_ICON_SIZE, DEVICE_ICON_SIZE],
    iconAnchor: [DEVICE_ICON_SIZE / 2, DEVICE_ICON_SIZE / 2],
  });
}

/** The "ball" travelling along a link line — plain positioning only; its
 *  look lives entirely in CSS so the animation loop just has to move it. */
function linkBallIcon(): L.DivIcon {
  return L.divIcon({
    className: 'link-ball-wrap',
    html: '<span class="link-ball"></span>',
    iconSize: [10, 10],
    iconAnchor: [5, 5],
  });
}

/** `YYYY-MM-DD` for a date input, in Johannesburg time rather than the browser's — same convention as the battery trend's range picker. */
function toDateInput(ms: number): string {
  return new Date(ms + 2 * 3_600_000).toISOString().slice(0, 10);
}

/** Reads a date input back as Johannesburg midnight (or the end of that day). */
function fromDateInput(value: string, endOfDay: boolean): number {
  const base = Date.parse(`${value}T00:00:00+02:00`);
  return endOfDay ? base + MOVEMENT_DAY_MS - 1 : base;
}

function formatFrameTime(ms: number): string {
  return new Date(ms).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', hour12: false });
}

function createBaseLayers(): Record<BaseName, L.TileLayer> {
  return {
    Satellite: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: MAX_ZOOM.Satellite,
      attribution: 'Esri, Maxar, Earthstar Geographics',
    }),
    Terrain: L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      maxZoom: MAX_ZOOM.Terrain,
      attribution: '&copy; OpenStreetMap, &copy; CARTO',
    }),
  };
}

export function MapView({
  mode,
  snapshots,
  selectedTagId,
  onSelect,
  fitNonce,
  autoFitKey,
  heatmapView,
  heatPoints,
  colorMode,
  discoveryIds,
  linkView,
  devices,
  orgId,
  movementSnapshots,
  orgPoints,
  geofences,
  geofencesView,
  children,
}: Props): JSX.Element {
  const container = useRef<HTMLDivElement | null>(null);
  const map = useRef<L.Map | null>(null);
  const bases = useRef<Record<BaseName, L.TileLayer> | null>(null);
  const markers = useRef<L.LayerGroup | null>(null);
  const heat = useRef<L.HeatLayer | null>(null);
  const links = useRef<L.LayerGroup | null>(null);
  const geofenceLayer = useRef<L.LayerGroup | null>(null);
  // Its own SVG renderer, same reasoning as the link lines below: cheap
  // insurance against churning the map's shared canvas renderer.
  const geofenceRenderer = useRef<L.SVG | null>(null);
  // Link lines get their own SVG renderer rather than sharing the map's
  // default canvas one that the tag markers use — the link layer is cleared
  // and rebuilt on its own schedule (every toggle, every snapshot refresh),
  // and churning a canvas renderer like that is exactly the failure mode the
  // heat layer above already had to work around (a redraw scheduled via
  // requestAnimationFrame firing after its context was torn down). A separate
  // SVG renderer can't corrupt the one circleMarkers depend on.
  const linkRenderer = useRef<L.SVG | null>(null);
  // One "ball" marker per link line, each pushed along its own origin→tag
  // segment by a single shared animation loop — see the link effect below.
  const linkBalls = useRef<Array<{ origin: { lat: number; lon: number }; tag: { lat: number; lon: number }; ball: L.Marker }>>(
    [],
  );
  const linkAnimFrame = useRef<number | null>(null);
  const deviceMarkers = useRef<L.LayerGroup | null>(null);
  const movementMarkers = useRef<L.LayerGroup | null>(null);
  const byTag = useRef(new Map<string, L.CircleMarker>());
  const fittedKey = useRef<string | null>(null);
  const [baseName, setBaseName] = useState<BaseName>('Satellite');
  const [tilesBlocked, setTilesBlocked] = useState(false);

  const [fromDate, setFromDate] = useState(() => toDateInput(Date.now() - 3 * MOVEMENT_DAY_MS));
  const [toDate, setToDate] = useState(() => toDateInput(Date.now()));
  const [speed, setSpeed] = useState<number>(1);
  const [replayLoading, setReplayLoading] = useState(false);
  const [replayError, setReplayError] = useState<string | null>(null);
  const [byTagPositions, setByTagPositions] = useState<Map<string, TagPosition[]> | null>(null);
  const [frames, setFrames] = useState<number[]>([]);
  const [frameIdx, setFrameIdx] = useState(0);
  const [playing, setPlaying] = useState(false);

  // Leaflet owns its own DOM, so the map is created once, ever, and then only
  // mutated — never rebuilt on a mode switch, which is what keeps the pan and
  // zoom (and the tiles already on screen) untouched when moving between the
  // global and movement views.
  useEffect(() => {
    if (!container.current || map.current) return;

    // Zoom sits bottom-left: the detail card takes the top-left corner, and
    // the legend the bottom-right (global mode only for both).
    const instance = L.map(container.current, { zoomControl: false, preferCanvas: true, maxZoom: MAX_ZOOM.Satellite })
      .setView(SOUTH_AFRICA, DEFAULT_ZOOM);
    L.control.zoom({ position: 'bottomleft' }).addTo(instance);
    const layers = createBaseLayers();
    layers.Satellite.addTo(instance);

    // Some networks block the tile CDNs outright. Rather than showing an empty
    // grey rectangle with no explanation, fall back to the vector basemap once
    // and then say plainly that imagery is unavailable — positions still plot.
    let failures = 0;
    layers.Satellite.on('tileerror', () => {
      if (++failures < 6) return;
      failures = 0;
      instance.removeLayer(layers.Satellite);
      layers.Terrain.addTo(instance);
      setBaseName('Terrain');
      layers.Terrain.on('tileerror', () => {
        if (++failures < 6) return;
        instance.removeLayer(layers.Terrain);
        setTilesBlocked(true);
      });
    });

    map.current = instance;
    bases.current = layers;
    markers.current = L.layerGroup().addTo(instance);
    deviceMarkers.current = L.layerGroup();
    movementMarkers.current = L.layerGroup();
    geofenceLayer.current = L.layerGroup();
    linkRenderer.current = L.svg({ padding: 0.5 });
    geofenceRenderer.current = L.svg({ padding: 0.5 });
    // heat.current and links.current are created lazily — see their own effects below.

    // The grid settles its own size after the first paint; without this the map
    // renders into a zero-height box and stays blank.
    const settle = setTimeout(() => instance.invalidateSize(), 200);
    const onResize = (): void => {
      instance.invalidateSize();
    };
    window.addEventListener('resize', onResize);

    return () => {
      clearTimeout(settle);
      window.removeEventListener('resize', onResize);
      instance.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    const instance = map.current;
    const layers = bases.current;
    if (!instance || !layers) return;

    for (const [name, layer] of Object.entries(layers) as Array<[BaseName, L.TileLayer]>) {
      if (name === baseName) {
        if (!instance.hasLayer(layer)) layer.addTo(instance);
      } else if (instance.hasLayer(layer)) {
        instance.removeLayer(layer);
      }
    }
    instance.setMaxZoom(MAX_ZOOM[baseName]);
  }, [baseName]);

  // Global markers are rebuilt whenever the visible set changes — kept up to
  // date regardless of mode, since that costs nothing while the layer isn't
  // even attached to the map (see the attach/detach effect below).
  useEffect(() => {
    const group = markers.current;
    if (!group) return;

    group.clearLayers();
    byTag.current.clear();
    const now = Date.now();

    for (const tag of snapshots) {
      if (tag.lat === null || tag.lon === null) continue;
      const fillColor =
        colorMode === 'age'
          ? ageColor(tag.fixAt, now)
          : colorMode === 'discovery'
            ? discoveryIds.has(tag.tagId)
              ? AGE_COLOR.live
              : AGE_COLOR.none
            : hasFreshGps(tag)
              ? AGE_COLOR.live
              : AGE_COLOR.none;
      const marker = L.circleMarker([tag.lat, tag.lon], {
        radius: 7,
        color: '#12140F',
        weight: 1.5,
        fillColor,
        fillOpacity: 0.95,
      });
      marker.on('click', () => onSelect(tag.tagId));
      marker.bindTooltip(tag.label ? `${tag.tagId} · ${tag.label}` : tag.tagId, { direction: 'top', offset: [0, -6] });
      marker.addTo(group);
      byTag.current.set(tag.tagId, marker);
    }
  }, [snapshots, onSelect, colorMode, discoveryIds]);

  // Markers vs. a density cloud of every raw fix, only in global mode — never
  // both at once, and never while the movement map is showing instead. The
  // heat layer is fully recreated (not updated in place) on every relevant
  // change: reusing one instance across a quick add/remove/add cycle left
  // leaflet.heat's own event listeners referencing a map it had just been
  // detached from, which crashed on the next redraw. A fresh instance has no
  // stale listeners.
  useEffect(() => {
    const instance = map.current;
    const markerLayer = markers.current;
    if (!instance || !markerLayer) return;

    if (heat.current) {
      instance.removeLayer(heat.current);
      heat.current = null;
    }

    if (mode === 'global' && heatmapView) {
      if (instance.hasLayer(markerLayer)) instance.removeLayer(markerLayer);
      const points = heatPoints.map((p): [number, number, number] => [p.lat, p.lon, 1]);
      // The reader itself isn't a tag fix, but it's still a real position worth
      // showing density at — folded into the same cloud rather than standing
      // out as its own marker, which the device-marker effect below hides for
      // exactly this view.
      for (const device of devices) {
        if (device.lat !== null && device.lon !== null) points.push([device.lat, device.lon, 1]);
      }
      heat.current = L.heatLayer(points, HEATMAP_OPTIONS).addTo(instance);
    } else if (mode === 'global' && !instance.hasLayer(markerLayer)) {
      markerLayer.addTo(instance);
    } else if (mode !== 'global' && instance.hasLayer(markerLayer)) {
      instance.removeLayer(markerLayer);
    }
  }, [mode, heatmapView, heatPoints, devices]);

  // A solid line per tag in the latest discovery whose data relayed through
  // another tag — or, if a reader's own radio id matches, straight to the
  // reader itself — only the latest round, so a tag absent from it (whether
  // toggled off, filtered out, or genuinely not heard) draws no line, the
  // same way it draws no marker. Meaningless without per-tag positions, so it
  // sits out whenever the heatmap is showing instead, or outside global mode.
  //
  // Direction (origin → tag) is shown by a small ball pushed along the line
  // rather than a static arrow — one shared requestAnimationFrame loop moves
  // every line's ball at once, at a steady 0.5Hz, so they all pulse in time.
  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    if (!links.current) links.current = L.layerGroup();
    const group = links.current;
    group.clearLayers();
    linkBalls.current = [];

    if (mode === 'global' && linkView && !heatmapView) {
      const latestIds = checkedInTagIds(snapshots, 'latest', Date.now());
      const byId = new Map(snapshots.map((t) => [t.tagId, t]));
      const deviceByRadioId = new Map(
        devices.filter((d): d is DeviceRow & { radioId: string; lat: number; lon: number } => d.radioId !== null && d.lat !== null && d.lon !== null)
          .map((d) => [d.radioId, d]),
      );

      for (const tag of snapshots) {
        if (!latestIds.has(tag.tagId) || !tag.linkId || tag.lat === null || tag.lon === null) continue;

        const targetTag = byId.get(tag.linkId);
        const origin: { lat: number; lon: number } | undefined =
          targetTag && targetTag.lat !== null && targetTag.lon !== null
            ? { lat: targetTag.lat, lon: targetTag.lon }
            : deviceByRadioId.get(tag.linkId);
        if (!origin) continue;

        const tagPoint: { lat: number; lon: number } = { lat: tag.lat, lon: tag.lon };
        L.polyline(
          [
            [origin.lat, origin.lon],
            [tagPoint.lat, tagPoint.lon],
          ],
          {
            color: LINK_COLOR,
            weight: 2,
            opacity: 0.85,
            interactive: false,
            renderer: linkRenderer.current ?? undefined,
          },
        ).addTo(group);

        const ball = L.marker([origin.lat, origin.lon], { icon: linkBallIcon(), interactive: false }).addTo(group);
        linkBalls.current.push({ origin, tag: tagPoint, ball });
      }
      if (!instance.hasLayer(group)) group.addTo(instance);
    } else if (instance.hasLayer(group)) {
      instance.removeLayer(group);
    }

    if (linkBalls.current.length === 0) return;

    // A 2s period is a 0.5Hz pulse. Each cycle is one push from origin to tag —
    // eased so the ball starts and ends gently, like something actually being
    // pushed through a pipe rather than sliding at a constant speed — and faded
    // in/out right at the seam so it reads as a discrete pulse, not a teleport.
    const PERIOD_MS = 2000;
    const animate = (time: number): void => {
      const t = (time % PERIOD_MS) / PERIOD_MS;
      const eased = (1 - Math.cos(t * Math.PI)) / 2;
      const fade = t < 0.06 ? t / 0.06 : t > 0.94 ? (1 - t) / 0.06 : 1;
      for (const seg of linkBalls.current) {
        seg.ball.setLatLng([
          seg.origin.lat + (seg.tag.lat - seg.origin.lat) * eased,
          seg.origin.lon + (seg.tag.lon - seg.origin.lon) * eased,
        ]);
        const el = seg.ball.getElement();
        if (el) el.style.opacity = String(Math.max(0.12, fade));
      }
      linkAnimFrame.current = requestAnimationFrame(animate);
    };
    linkAnimFrame.current = requestAnimationFrame(animate);

    return () => {
      if (linkAnimFrame.current !== null) {
        cancelAnimationFrame(linkAnimFrame.current);
        linkAnimFrame.current = null;
      }
    };
  }, [mode, linkView, heatmapView, snapshots, devices]);

  // The movement layer is attached only in movement mode — everything about
  // what it draws lives in the effect further down; this just controls
  // whether it's on the map at all.
  useEffect(() => {
    const instance = map.current;
    const moveLayer = movementMarkers.current;
    if (!instance || !moveLayer) return;
    if (mode === 'movement') {
      if (!instance.hasLayer(moveLayer)) moveLayer.addTo(instance);
    } else if (instance.hasLayer(moveLayer)) {
      instance.removeLayer(moveLayer);
    }
  }, [mode]);

  // The reader's own position — a landmark, not tag data, so it stays up
  // regardless of the link toggle. The heatmap is the one exception: there
  // the reader's position folds into the density cloud instead (see the heat
  // layer effect above), so the standout marker steps aside rather than
  // sitting on top of it.
  useEffect(() => {
    const instance = map.current;
    const group = deviceMarkers.current;
    if (!instance || !group) return;
    if (mode === 'global' && !heatmapView) {
      if (!instance.hasLayer(group)) group.addTo(instance);
    } else if (instance.hasLayer(group)) {
      instance.removeLayer(group);
    }
  }, [mode, heatmapView]);

  useEffect(() => {
    const group = deviceMarkers.current;
    if (!group) return;
    group.clearLayers();
    for (const device of devices) {
      if (device.lat === null || device.lon === null) continue;
      const marker = L.marker([device.lat, device.lon], { icon: deviceIcon(), zIndexOffset: 1000 });
      marker.bindTooltip(device.label ? `${device.label} · reader` : `Reader ${device.imei}`, {
        direction: 'top',
        offset: [0, -10],
      });
      marker.addTo(group);
    }
  }, [devices]);

  // Geofence boundaries — available in either view, toggled independently of
  // everything else, and never touches pan or zoom: only the attach/detach
  // below changes when the toggle flips.
  useEffect(() => {
    const instance = map.current;
    const group = geofenceLayer.current;
    if (!instance || !group) return;
    if (geofencesView) {
      if (!instance.hasLayer(group)) group.addTo(instance);
    } else if (instance.hasLayer(group)) {
      instance.removeLayer(group);
    }
  }, [geofencesView]);

  useEffect(() => {
    const group = geofenceLayer.current;
    if (!group) return;
    group.clearLayers();
    for (const fence of geofences) {
      if (fence.coordinates.length < 3) continue;
      const polygon = L.polygon(fence.coordinates, {
        color: fence.color ?? '#E9AE2F',
        weight: 2,
        fillOpacity: 0.06,
        interactive: false,
        renderer: geofenceRenderer.current ?? undefined,
      });
      polygon.bindTooltip(fence.name, { direction: 'center' });
      polygon.addTo(group);
    }
  }, [geofences]);

  // Selection is a style change on the existing markers, so picking a tag from
  // the sidebar does not rebuild the layer or disturb the view.
  useEffect(() => {
    for (const [tagId, marker] of byTag.current) {
      const selected = tagId === selectedTagId;
      marker.setStyle({ color: selected ? '#E8E4D6' : '#12140F', weight: selected ? 2.5 : 1.5 });
      marker.setRadius(selected ? 10 : 7);
      if (selected) marker.bringToFront();
    }

    const instance = map.current;
    const marker = selectedTagId ? byTag.current.get(selectedTagId) : null;
    if (instance && marker) {
      instance.setView(marker.getLatLng(), Math.max(instance.getZoom(), 14), { animate: true });
    }
  }, [selectedTagId, snapshots]);

  const fit = useCallback((): void => {
    const instance = map.current;
    if (!instance) return;

    const points = snapshots
      .filter((t) => t.lat !== null && t.lon !== null)
      .map((t) => [t.lat as number, t.lon as number] as [number, number]);

    if (points.length === 0) {
      instance.setView(SOUTH_AFRICA, DEFAULT_ZOOM);
      return;
    }
    instance.fitBounds(L.latLngBounds(points), { padding: [50, 50], maxZoom: 15 });
  }, [snapshots]);

  // Unlike `fit`, which frames whatever the list currently shows, this always
  // frames every tag the org has a position for — the toggles and search box
  // don't shrink what "recentre" means. Works the same in both modes.
  const recenter = useCallback((): void => {
    const instance = map.current;
    if (!instance) return;
    if (orgPoints.length === 0) {
      instance.setView(SOUTH_AFRICA, DEFAULT_ZOOM);
      return;
    }
    instance.fitBounds(L.latLngBounds(orgPoints), { padding: [50, 50], maxZoom: 15 });
  }, [orgPoints]);

  // Explicit request from the header's wordmark.
  const firstFit = useRef(true);
  useEffect(() => {
    if (firstFit.current) {
      firstFit.current = false;
      return;
    }
    fit();
  }, [fitNonce]);

  // Frame the tags once they first arrive, and again when the organisation
  // being looked at changes — but never afterwards, so a refresh a minute later
  // does not yank the view back from wherever the user panned it to.
  useEffect(() => {
    const positioned = snapshots.some((t) => t.lat !== null);
    if (!positioned || fittedKey.current === autoFitKey) return;
    fittedKey.current = autoFitKey;
    fit();
  }, [snapshots, autoFitKey, fit]);

  // --- Movement replay ---------------------------------------------------

  const movementTagIds = movementSnapshots.map((s) => s.tagId);
  const replayStartAt = fromDateInput(fromDate, false);
  const replayEndAt = fromDateInput(toDate, true);

  // Loading resets which positions are plotted (the whole point of "load"),
  // but never touches the map's own pan or zoom — recentre is a separate,
  // explicit action. `autoplay` lets the Play button double as "load and go"
  // the first time it's pressed, before anything has been loaded yet.
  const loadReplay = useCallback(
    (autoplay: boolean): void => {
      if (!orgId || movementTagIds.length === 0 || replayStartAt >= replayEndAt) return;
      setReplayLoading(true);
      setReplayError(null);
      setPlaying(false);
      api
        .fetchTagPositions(orgId, replayStartAt, replayEndAt, movementTagIds)
        .then((res) => {
          const grouped = new Map<string, TagPosition[]>();
          for (const p of res.points) {
            const list = grouped.get(p.tagId);
            if (list) list.push(p);
            else grouped.set(p.tagId, [p]);
          }
          const sortedFrames = [...new Set(res.points.map((p) => p.t))].sort((a, b) => a - b);
          setByTagPositions(grouped);
          setFrames(sortedFrames);
          setFrameIdx(0);
          setReplayError(sortedFrames.length === 0 ? 'No GPS fixes for the toggled-on tags in that window.' : null);
          if (autoplay && sortedFrames.length > 0) setPlaying(true);
        })
        .catch((e: unknown) => setReplayError(e instanceof Error ? e.message : 'Failed to load positions.'))
        .finally(() => setReplayLoading(false));
    },
    [orgId, movementSnapshots, replayStartAt, replayEndAt],
  );

  const togglePlay = useCallback((): void => {
    if (byTagPositions === null) {
      loadReplay(true);
      return;
    }
    setPlaying((p) => !p);
  }, [byTagPositions, loadReplay]);

  // Advances one frame per tick; stops itself at the last frame.
  useEffect(() => {
    if (!playing || frames.length === 0) return;
    if (frameIdx >= frames.length - 1) {
      setPlaying(false);
      return;
    }
    const timer = setTimeout(() => setFrameIdx((i) => Math.min(i + 1, frames.length - 1)), MOVEMENT_FRAME_INTERVAL_MS / speed);
    return () => clearTimeout(timer);
  }, [playing, frameIdx, frames, speed]);

  // Before a replay is loaded, plots each toggled-on tag at its current
  // position — the same fix the global map would show. Once loaded, plots
  // each tag's latest known position at or before the current frame's
  // timestamp instead — a moving snapshot, not an accumulating trail. Kept
  // in sync regardless of mode, same reasoning as the global markers above.
  useEffect(() => {
    const group = movementMarkers.current;
    if (!group) return;
    group.clearLayers();

    const plot = (lat: number, lon: number, tagId: string, label: string | null): void => {
      const marker = L.circleMarker([lat, lon], {
        radius: 6,
        color: '#12140F',
        weight: 1.5,
        fillColor: MOVEMENT_GREEN,
        fillOpacity: 0.95,
      });
      marker.bindTooltip(label ? `${tagId} · ${label}` : tagId, { direction: 'top', offset: [0, -6] });
      marker.addTo(group);
    };

    if (byTagPositions === null) {
      for (const s of movementSnapshots) {
        if (s.lat !== null && s.lon !== null) plot(s.lat, s.lon, s.tagId, s.label);
      }
      return;
    }

    const cutoff = frames[frameIdx];
    if (cutoff === undefined) return;
    for (const [tagId, points] of byTagPositions) {
      let latest: TagPosition | null = null;
      for (const p of points) {
        if (p.t > cutoff) break;
        latest = p;
      }
      if (latest) plot(latest.lat, latest.lon, tagId, movementSnapshots.find((s) => s.tagId === tagId)?.label ?? null);
    }
  }, [byTagPositions, frames, frameIdx, movementSnapshots]);

  const currentReplayTime = frames[frameIdx];

  return (
    <main>
      <div id="map" ref={container} />
      {tilesBlocked && (
        <div className="map-note">
          Basemap tiles are blocked on this network. Tag positions still plot — open the app from a network that can
          reach the imagery CDN to get the picture back.
        </div>
      )}
      <div className="map-topright" style={{ position: 'absolute', right: 14, top: 14, zIndex: 600 }}>
        <button className="pill pill-recentre" onClick={recenter} title="Frame every tag the organisation has a position for">
          Recentre
        </button>
      </div>

      {mode === 'global' ? (
        children
      ) : (
        <div className="map-topleft">
          <div className="card movement-controls">
            <h3>Movement replay</h3>
            <div className="sub">
              {movementTagIds.length} tag{movementTagIds.length === 1 ? '' : 's'} toggled on
            </div>

            <label className="movement-field">
              Start
              <input type="date" value={fromDate} max={toDate} onChange={(e) => setFromDate(e.target.value)} />
            </label>
            <label className="movement-field">
              End
              <input type="date" value={toDate} min={fromDate} onChange={(e) => setToDate(e.target.value)} />
            </label>

            <label className="movement-field">
              Speed
              <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
                {MOVEMENT_SPEEDS.map((s) => (
                  <option key={s} value={s}>
                    {s}×
                  </option>
                ))}
              </select>
            </label>
            <button
              className="pill"
              style={{ width: '100%', marginTop: 10 }}
              onClick={() => loadReplay(false)}
              disabled={replayLoading || movementTagIds.length === 0}
            >
              {replayLoading ? 'Loading…' : 'Load replay'}
            </button>

            {movementTagIds.length === 0 && (
              <div className="empty" style={{ padding: '8px 0 0' }}>
                No tags toggled on — switch some on in the list to replay them.
              </div>
            )}
            {replayError && <div className="status-error">{replayError}</div>}

            <button
              className="pill"
              style={{ width: '100%', marginTop: 10 }}
              onClick={togglePlay}
              disabled={replayLoading || movementTagIds.length === 0}
            >
              {replayLoading ? 'Loading…' : playing ? 'Pause' : 'Play'}
            </button>
            {frames.length > 0 && (
              <input
                type="range"
                min={0}
                max={frames.length - 1}
                value={frameIdx}
                onChange={(e) => {
                  setPlaying(false);
                  setFrameIdx(Number(e.target.value));
                }}
                style={{ width: '100%', marginTop: 10 }}
              />
            )}
            {frames.length > 0 && (
              <div className="sub" style={{ margin: '6px 0 0' }}>
                {currentReplayTime !== undefined ? formatFrameTime(currentReplayTime) : ''}
                {` · frame ${frameIdx + 1}/${frames.length}`}
              </div>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
