import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import type { TagPosition, TagSnapshot } from '@tagexplore/core';
import * as api from '../api.js';
import { DEFAULT_ZOOM, SOUTH_AFRICA, type MapViewState } from '../mapDefaults.js';

interface Props {
  orgId: string | null;
  /** Tags currently toggled on in the main list — the same set the global map plots, and
   *  what this view shows at their current position before a replay is ever loaded. */
  snapshots: TagSnapshot[];
  /** Every org tag's own latest position, regardless of the list's toggles — what "Recentre" frames to. */
  orgPoints: Array<[number, number]>;
  /** Where the map opens — read once, on mount, so switching to the global map and back keeps the view. */
  initialView: MapViewState;
  /** Fired on every pan/zoom so the parent can hand the same view back on remount. */
  onViewChange: (view: MapViewState) => void;
}

const DAY_MS = 86_400_000;
const SPEEDS = [1, 2, 4, 8, 16] as const;
/** Wall-clock ms between animation frames at 1×. */
const FRAME_INTERVAL_MS = 500;
const GREEN = '#4FBF8B';

/** `YYYY-MM-DD` for a date input, in Johannesburg time rather than the browser's — same convention as the battery trend's range picker. */
function toDateInput(ms: number): string {
  return new Date(ms + 2 * 3_600_000).toISOString().slice(0, 10);
}

/** Reads a date input back as Johannesburg midnight (or the end of that day). */
function fromDateInput(value: string, endOfDay: boolean): number {
  const base = Date.parse(`${value}T00:00:00+02:00`);
  return endOfDay ? base + DAY_MS - 1 : base;
}

function formatFrameTime(ms: number): string {
  return new Date(ms).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', hour12: false });
}

/**
 * Replays a chosen set of tags' GPS fixes over a chosen timeframe — a
 * separate view from the global map, not a mode of it. Every plotted point is
 * the same green: this view is about where tags were and when, not their
 * current freshness, so it carries none of the global map's legends. Before a
 * replay is loaded it shows the same current positions the global map would,
 * so switching here never lands on a blank map.
 */
export function MovementMap({ orgId, snapshots, orgPoints, initialView, onViewChange }: Props): JSX.Element {
  const container = useRef<HTMLDivElement | null>(null);
  const map = useRef<L.Map | null>(null);
  const markers = useRef<L.LayerGroup | null>(null);

  const [fromDate, setFromDate] = useState(() => toDateInput(Date.now() - 3 * DAY_MS));
  const [toDate, setToDate] = useState(() => toDateInput(Date.now()));
  const [speed, setSpeed] = useState<number>(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [byTag, setByTag] = useState<Map<string, TagPosition[]> | null>(null);
  const [frames, setFrames] = useState<number[]>([]);
  const [frameIdx, setFrameIdx] = useState(0);
  const [playing, setPlaying] = useState(false);

  const tagIds = useMemo(() => snapshots.map((s) => s.tagId), [snapshots]);
  const startAt = useMemo(() => fromDateInput(fromDate, false), [fromDate]);
  const endAt = useMemo(() => fromDateInput(toDate, true), [toDate]);

  // Leaflet owns its own DOM — created once, then mutated, same as the global map.
  // `initialView` is only read here, at mount: it is where this box last left
  // off (possibly on the global map), not something to snap back to later.
  useEffect(() => {
    if (!container.current || map.current) return;
    const instance = L.map(container.current, { zoomControl: false, preferCanvas: true, maxZoom: 17 }).setView(
      initialView.center,
      initialView.zoom,
    );
    L.control.zoom({ position: 'bottomleft' }).addTo(instance);
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 17,
      attribution: 'Esri, Maxar, Earthstar Geographics',
    }).addTo(instance);
    markers.current = L.layerGroup().addTo(instance);
    map.current = instance;

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

  // Reports every pan and zoom — including programmatic ones, like a recentre
  // — back up so the global map can pick up here when switched to.
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

  const recenter = useCallback((): void => {
    const instance = map.current;
    if (!instance) return;
    if (orgPoints.length === 0) {
      instance.setView(SOUTH_AFRICA, DEFAULT_ZOOM);
      return;
    }
    instance.fitBounds(L.latLngBounds(orgPoints), { padding: [50, 50], maxZoom: 15 });
  }, [orgPoints]);

  // Loading resets which positions are plotted (the whole point of "load"),
  // but never touches the map's own pan or zoom — recentre is a separate,
  // explicit action. `autoplay` lets the Play button double as "load and go"
  // the first time it's pressed, before anything has been loaded yet.
  const load = useCallback(
    (autoplay: boolean): void => {
      if (!orgId || tagIds.length === 0 || startAt >= endAt) return;
      setLoading(true);
      setError(null);
      setPlaying(false);
      api
        .fetchTagPositions(orgId, startAt, endAt, tagIds)
        .then((res) => {
          const grouped = new Map<string, TagPosition[]>();
          for (const p of res.points) {
            const list = grouped.get(p.tagId);
            if (list) list.push(p);
            else grouped.set(p.tagId, [p]);
          }
          const sortedFrames = [...new Set(res.points.map((p) => p.t))].sort((a, b) => a - b);
          setByTag(grouped);
          setFrames(sortedFrames);
          setFrameIdx(0);
          setError(sortedFrames.length === 0 ? 'No GPS fixes for the toggled-on tags in that window.' : null);
          if (autoplay && sortedFrames.length > 0) setPlaying(true);
        })
        .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load positions.'))
        .finally(() => setLoading(false));
    },
    [orgId, tagIds, startAt, endAt],
  );

  const togglePlay = useCallback((): void => {
    if (byTag === null) {
      load(true);
      return;
    }
    setPlaying((p) => !p);
  }, [byTag, load]);

  // Advances one frame per tick; stops itself at the last frame.
  useEffect(() => {
    if (!playing || frames.length === 0) return;
    if (frameIdx >= frames.length - 1) {
      setPlaying(false);
      return;
    }
    const timer = setTimeout(() => setFrameIdx((i) => Math.min(i + 1, frames.length - 1)), FRAME_INTERVAL_MS / speed);
    return () => clearTimeout(timer);
  }, [playing, frameIdx, frames, speed]);

  // Before a replay is loaded, plots each toggled-on tag at its current
  // position — the same fix the global map would show. Once loaded, plots
  // each tag's latest known position at or before the current frame's
  // timestamp instead — a moving snapshot, not an accumulating trail.
  useEffect(() => {
    const group = markers.current;
    if (!group) return;
    group.clearLayers();

    const plot = (lat: number, lon: number, tagId: string, label: string | null): void => {
      const marker = L.circleMarker([lat, lon], {
        radius: 6,
        color: '#12140F',
        weight: 1.5,
        fillColor: GREEN,
        fillOpacity: 0.95,
      });
      marker.bindTooltip(label ? `${tagId} · ${label}` : tagId, { direction: 'top', offset: [0, -6] });
      marker.addTo(group);
    };

    if (byTag === null) {
      for (const s of snapshots) {
        if (s.lat !== null && s.lon !== null) plot(s.lat, s.lon, s.tagId, s.label);
      }
      return;
    }

    const cutoff = frames[frameIdx];
    if (cutoff === undefined) return;
    for (const [tagId, points] of byTag) {
      let latest: TagPosition | null = null;
      for (const p of points) {
        if (p.t > cutoff) break;
        latest = p;
      }
      if (latest) plot(latest.lat, latest.lon, tagId, snapshots.find((s) => s.tagId === tagId)?.label ?? null);
    }
  }, [byTag, frames, frameIdx, snapshots]);

  const currentTime = frames[frameIdx];

  return (
    <main>
      <div id="movement-map" ref={container} />
      <div className="map-topright" style={{ position: 'absolute', right: 14, top: 14, zIndex: 600 }}>
        <button className="pill pill-recentre" onClick={recenter} title="Frame every tag the organisation has a position for">
          Recentre
        </button>
      </div>
      <div className="map-topleft">
        <div className="card movement-controls">
          <h3>Movement replay</h3>
          <div className="sub">
            {tagIds.length} tag{tagIds.length === 1 ? '' : 's'} toggled on
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
              {SPEEDS.map((s) => (
                <option key={s} value={s}>
                  {s}×
                </option>
              ))}
            </select>
          </label>
          <button
            className="pill"
            style={{ width: '100%', marginTop: 10 }}
            onClick={() => load(false)}
            disabled={loading || tagIds.length === 0}
          >
            {loading ? 'Loading…' : 'Load replay'}
          </button>

          {tagIds.length === 0 && (
            <div className="empty" style={{ padding: '8px 0 0' }}>
              No tags toggled on — switch some on in the list to replay them.
            </div>
          )}
          {error && <div className="status-error">{error}</div>}

          <button
            className="pill"
            style={{ width: '100%', marginTop: 10 }}
            onClick={togglePlay}
            disabled={loading || tagIds.length === 0}
          >
            {loading ? 'Loading…' : playing ? 'Pause' : 'Play'}
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
              {currentTime !== undefined ? formatFrameTime(currentTime) : ''}
              {` · frame ${frameIdx + 1}/${frames.length}`}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
