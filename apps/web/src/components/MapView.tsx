import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import L from 'leaflet';
import 'leaflet.heat';
import { AGE_COLOR, ageColor, type GpsPoint, type TagSnapshot } from '@tagexplore/core';
import { DEFAULT_ZOOM as DEFAULT_ZOOM_FALLBACK, SOUTH_AFRICA, type MapViewState } from '../mapDefaults.js';

/** What a marker's fill colour means — picked by clicking one of the three legends. */
export type MarkerColorMode = 'age' | 'latestGps' | 'discovery';

interface Props {
  snapshots: TagSnapshot[];
  /** The detail card and legend, which sit over the map inside the same box. */
  children?: ReactNode;
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
  /** Every org tag's own latest position, regardless of the list's toggles — what "Recentre" frames to. */
  orgPoints: Array<[number, number]>;
  /** Where the map opens — read once, on mount, so switching to the movement map and back keeps the view. */
  initialView: MapViewState;
  /** Fired on every pan/zoom so the parent can hand the same view back on remount. */
  onViewChange: (view: MapViewState) => void;
}

/** True when the tag's most recent reading — not just some earlier one — carried a GPS fix. */
function hasFreshGps(tag: TagSnapshot): boolean {
  return tag.fixAt !== null && tag.fixAt === tag.lastSeenAt;
}

/**
 * Esri's imagery thins out over rural South Africa — past zoom 17 you get "map
 * data not yet available" tiles instead of a picture, so the satellite layer is
 * capped there while the vector fallback can go closer.
 */
const MAX_ZOOM = { Satellite: 17, Terrain: 19 } as const;
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
  snapshots,
  selectedTagId,
  onSelect,
  fitNonce,
  autoFitKey,
  heatmapView,
  heatPoints,
  colorMode,
  discoveryIds,
  orgPoints,
  initialView,
  onViewChange,
  children,
}: Props): JSX.Element {
  const container = useRef<HTMLDivElement | null>(null);
  const map = useRef<L.Map | null>(null);
  const bases = useRef<Record<BaseName, L.TileLayer> | null>(null);
  const markers = useRef<L.LayerGroup | null>(null);
  const heat = useRef<L.HeatLayer | null>(null);
  const byTag = useRef(new Map<string, L.CircleMarker>());
  const fittedKey = useRef<string | null>(null);
  const [baseName, setBaseName] = useState<BaseName>('Satellite');
  const [tilesBlocked, setTilesBlocked] = useState(false);

  // Leaflet owns its own DOM, so the map is created once and then mutated —
  // rebuilding it on every render would throw away the user's pan and zoom.
  // `initialView` is only read here, at mount: it is where this box last left
  // off (possibly on the movement map), not something to snap back to later.
  useEffect(() => {
    if (!container.current || map.current) return;

    // Zoom sits bottom-left: the detail card takes the top-left corner, the
    // basemap toggle the top-right, and the legend the bottom-right.
    const instance = L.map(container.current, { zoomControl: false, preferCanvas: true, maxZoom: MAX_ZOOM.Satellite })
      .setView(initialView.center, initialView.zoom);
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
    // heat.current is created lazily — see the heatmapView effect below.

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

  // Reports every pan and zoom — including programmatic ones, like a fit or a
  // recentre — back up so the movement map can pick up here when switched to.
  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    const report = (): void => {
      const c = instance.getCenter();
      onViewChange({ center: [c.lat, c.lng], zoom: instance.getZoom() });
    };
    instance.on('moveend', report);
    instance.on('zoomend', report);
    return () => {
      instance.off('moveend', report);
      instance.off('zoomend', report);
    };
  }, [onViewChange]);

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

  // Markers are rebuilt whenever the visible set changes. There are tens to
  // low hundreds of tags, so a clean rebuild is cheaper to reason about than
  // diffing, and Leaflet's canvas renderer handles the redraw comfortably.
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

  // The two views are mutually exclusive: markers for individual tags, or a
  // density cloud of every raw fix — never both at once. The heat layer is
  // fully recreated (not updated in place) on every relevant change: reusing
  // one instance across a quick add/remove/add cycle left leaflet.heat's own
  // event listeners referencing a map it had just been detached from, which
  // crashed on the next redraw. A fresh instance has no stale listeners.
  useEffect(() => {
    const instance = map.current;
    const markerLayer = markers.current;
    if (!instance || !markerLayer) return;

    if (heat.current) {
      instance.removeLayer(heat.current);
      heat.current = null;
    }

    if (heatmapView) {
      if (instance.hasLayer(markerLayer)) instance.removeLayer(markerLayer);
      const points = heatPoints.map((p): [number, number, number] => [p.lat, p.lon, 1]);
      heat.current = L.heatLayer(points, HEATMAP_OPTIONS).addTo(instance);
    } else if (!instance.hasLayer(markerLayer)) {
      markerLayer.addTo(instance);
    }
  }, [heatmapView, heatPoints]);

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
      instance.setView(SOUTH_AFRICA, DEFAULT_ZOOM_FALLBACK);
      return;
    }
    instance.fitBounds(L.latLngBounds(points), { padding: [50, 50], maxZoom: 15 });
  }, [snapshots]);

  // Unlike `fit`, which frames whatever the list currently shows, this always
  // frames every tag the org has a position for — the toggles and search box
  // don't shrink what "recentre" means.
  const recenter = useCallback((): void => {
    const instance = map.current;
    if (!instance) return;
    if (orgPoints.length === 0) {
      instance.setView(SOUTH_AFRICA, DEFAULT_ZOOM_FALLBACK);
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
      {children}
    </main>
  );
}
