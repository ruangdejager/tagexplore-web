import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import L from 'leaflet';
import { ageColor, type TagSnapshot } from '@tagexplore/core';

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
}

/**
 * Esri's imagery thins out over rural South Africa — past zoom 17 you get "map
 * data not yet available" tiles instead of a picture, so the satellite layer is
 * capped there while the vector fallback can go closer.
 */
const MAX_ZOOM = { Satellite: 17, Terrain: 19 } as const;
type BaseName = keyof typeof MAX_ZOOM;

const SOUTH_AFRICA: L.LatLngExpression = [-28.8, 24.5];

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

export function MapView({ snapshots, selectedTagId, onSelect, fitNonce, autoFitKey, children }: Props): JSX.Element {
  const container = useRef<HTMLDivElement | null>(null);
  const map = useRef<L.Map | null>(null);
  const bases = useRef<Record<BaseName, L.TileLayer> | null>(null);
  const markers = useRef<L.LayerGroup | null>(null);
  const byTag = useRef(new Map<string, L.CircleMarker>());
  const fittedKey = useRef<string | null>(null);
  const [baseName, setBaseName] = useState<BaseName>('Satellite');
  const [tilesBlocked, setTilesBlocked] = useState(false);

  // Leaflet owns its own DOM, so the map is created once and then mutated —
  // rebuilding it on every render would throw away the user's pan and zoom.
  useEffect(() => {
    if (!container.current || map.current) return;

    // Zoom sits bottom-left: the detail card takes the top-left corner, the
    // basemap toggle the top-right, and the legend the bottom-right.
    const instance = L.map(container.current, { zoomControl: false, preferCanvas: true, maxZoom: MAX_ZOOM.Satellite })
      .setView(SOUTH_AFRICA, 5);
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
      const marker = L.circleMarker([tag.lat, tag.lon], {
        radius: 7,
        color: '#12140F',
        weight: 1.5,
        fillColor: ageColor(tag.fixAt, now),
        fillOpacity: 0.95,
      });
      marker.on('click', () => onSelect(tag.tagId));
      marker.bindTooltip(tag.label ? `${tag.tagId} · ${tag.label}` : tag.tagId, { direction: 'top', offset: [0, -6] });
      marker.addTo(group);
      byTag.current.set(tag.tagId, marker);
    }
  }, [snapshots, onSelect]);

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
      instance.setView(SOUTH_AFRICA, 5);
      return;
    }
    instance.fitBounds(L.latLngBounds(points), { padding: [50, 50], maxZoom: 15 });
  }, [snapshots]);

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
      <button
        className="pill"
        style={{ position: 'absolute', right: 14, top: 14, zIndex: 600 }}
        onClick={() => setBaseName((n) => (n === 'Satellite' ? 'Terrain' : 'Satellite'))}
      >
        {baseName}
      </button>
      {children}
    </main>
  );
}
