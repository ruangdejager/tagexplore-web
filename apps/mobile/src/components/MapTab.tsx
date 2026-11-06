import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet.heat';
import 'leaflet/dist/leaflet.css';
import {
  checkedInTagIds,
  type DeviceRow,
  type DiscoveryWindow,
  type GeofenceRegion,
  type GpsPoint,
  type LinkReading,
  type TagSnapshot,
} from '@tagexplore/core';
import * as api from '../api.js';
import { usePref } from '../prefs.js';
import type { OrgData } from '../useOrgData.js';
import { CountBlock } from './CountBlock.js';
import { FunctionsBlock, HEATMAP_HOURS, NO_MAP_FUNCTIONS, type MapFunctions } from './FunctionsBlock.js';

const COLOR = { alert: '#c13615', checkedIn: '#4fbf8b', notCheckedIn: '#9aa08c' } as const;
const SOUTH_AFRICA: [number, number] = [-28.8, 24.5];
const FOCUS_ZOOM = 17;
/** Same look as the desktop heatmap, so the two read the same density the same way. */
const HEATMAP_OPTIONS: L.HeatMapOptions = { radius: 12, blur: 10, max: 11, minOpacity: 0.08 };
const LINK_COLOR = '#4FBF8B';
/** One push of the ball along a link line, origin to tag, as on the desktop. */
const LINK_PERIOD_MS = 2000;

function deviceIcon(source: DeviceRow['positionSource']): L.DivIcon {
  const variant = source === 'stale' ? ' stale' : source === 'linked-tag' ? ' via-tag' : '';
  return L.divIcon({
    className: `device-marker-wrap${variant}`,
    html: '<span class="device-marker-ping"></span><span class="device-marker-dot"></span>',
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });
}

/**
 * The map tab: satellite imagery, one dot per switched-on tag at its last GPS
 * fix, and the count block over the top.
 *
 * It stays mounted while other tabs are showing (hidden, not removed), so
 * switching back is instant and "Show on map" jumps straight to the tag
 * instead of rebuilding the map and animating across the country.
 *
 * Dots carry no labels; tapping one opens the tag's card. Colour follows the
 * count's window, as on the desktop: green for a tag heard in that window,
 * grey for one that wasn't, red for a tag in alert.
 */
export function MapTab(props: {
  orgId: string;
  data: OrgData;
  visible: boolean;
  focus: { tagId: string; n: number } | null;
  /** `snap` is passed while browsing history, so the card shows that round's reading rather than today's. */
  onOpenTag: (tagId: string, snap?: TagSnapshot) => void;
  /** Whether the Map functions block is switched on in settings. Off means every function is off. */
  showFunctions: boolean;
}): JSX.Element {
  const { orgId, data, visible, focus } = props;
  const el = useRef<HTMLDivElement | null>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const geofenceLayer = useRef<L.LayerGroup | null>(null);
  const linkLayer = useRef<L.LayerGroup | null>(null);
  const deviceLayer = useRef<L.LayerGroup | null>(null);
  const heat = useRef<L.HeatLayer | null>(null);
  const svgRenderer = useRef<L.SVG | null>(null);
  const balls = useRef<Array<{ from: [number, number]; to: [number, number]; ball: L.Marker }>>([]);
  const pulse = useRef<L.Marker | null>(null);
  const fittedOrg = useRef<string | null>(null);
  const onOpen = useRef(props.onOpenTag);
  onOpen.current = props.onOpenTag;

  const [windowChoice, setWindowChoice] = useState<DiscoveryWindow>('6');
  const [historyAt, setHistoryAt] = useState<number | null>(null);
  const [historySnaps, setHistorySnaps] = useState<TagSnapshot[] | null>(null);
  const [historyLinks, setHistoryLinks] = useState<LinkReading[] | null>(null);
  const [historyDevices, setHistoryDevices] = useState<DeviceRow[] | null>(null);

  const [savedFunctions, setFunctions] = usePref<MapFunctions>('tx-m-map-functions', NO_MAP_FUNCTIONS);
  const fns = props.showFunctions ? savedFunctions : NO_MAP_FUNCTIONS;
  const [geofences, setGeofences] = useState<GeofenceRegion[] | null>(null);
  const [heatPoints, setHeatPoints] = useState<GpsPoint[] | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => setNow(Date.now()), [data.updatedAt]);
  useEffect(() => setHistoryAt(null), [orgId]);

  useEffect(() => {
    if (historyAt === null) {
      setHistorySnaps(null);
      setHistoryLinks(null);
      setHistoryDevices(null);
      return;
    }
    let cancelled = false;
    api
      .fetchSnapshotsAt(orgId, historyAt)
      .then((res) => {
        if (cancelled) return;
        setHistorySnaps(res.snapshots);
        setHistoryLinks(res.links ?? []);
      })
      .catch(() => {
        if (cancelled) return;
        setHistorySnaps([]);
        setHistoryLinks([]);
      });
    // The readers as they were for that round, so link lines start where the
    // reader actually was then.
    api
      .fetchDevicesAt(orgId, historyAt)
      .then((res) => !cancelled && setHistoryDevices(res.devices))
      .catch(() => !cancelled && setHistoryDevices(null));
    return () => {
      cancelled = true;
    };
  }, [orgId, historyAt]);

  // Geofences: fetched once per organisation, the first time they're switched on.
  useEffect(() => setGeofences(null), [orgId]);
  useEffect(() => {
    if (!fns.geofences || geofences !== null) return;
    let cancelled = false;
    api
      .fetchGeofences(orgId)
      .then((res) => !cancelled && setGeofences(res.geofences))
      .catch(() => !cancelled && setGeofences([]));
    return () => {
      cancelled = true;
    };
  }, [fns.geofences, geofences, orgId]);

  // Heatmap: the last 7 days of raw fixes, re-read as new data lands.
  useEffect(() => {
    if (!fns.heatmap) {
      setHeatPoints(null);
      return;
    }
    let cancelled = false;
    api
      .fetchPositions(orgId, HEATMAP_HOURS)
      .then((res) => !cancelled && setHeatPoints(res.points))
      .catch(() => !cancelled && setHeatPoints([]));
    return () => {
      cancelled = true;
    };
  }, [fns.heatmap, orgId, data.updatedAt]);

  const hidden = useMemo(() => new Set(data.rows.filter((r) => r.hidden).map((r) => r.tagId)), [data.rows]);
  const alerting = useMemo(() => new Set(data.alerts.map((a) => a.tagId)), [data.alerts]);

  /** What the map and the count are showing: live, or the picked round. */
  const shown = useMemo<TagSnapshot[]>(() => {
    if (historyAt !== null) return (historySnaps ?? []).filter((s) => !hidden.has(s.tagId));
    return data.watched.flatMap((r) => (r.snap ? [r.snap] : []));
  }, [historyAt, historySnaps, hidden, data.watched]);

  const refNow = historyAt ?? now;
  const checkedIn = useMemo(() => checkedInTagIds(shown, windowChoice, refNow), [shown, windowChoice, refNow]);

  useEffect(() => {
    if (!el.current) return;
    const m = L.map(el.current, { zoomControl: false, attributionControl: true }).setView(SOUTH_AFRICA, 5);
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19,
      attribution: 'Esri, Maxar',
    }).addTo(m);
    svgRenderer.current = L.svg({ padding: 0.5 });
    // Bottom to top: geofences, link lines, tag dots, readers.
    geofenceLayer.current = L.layerGroup();
    linkLayer.current = L.layerGroup();
    layer.current = L.layerGroup().addTo(m);
    deviceLayer.current = L.layerGroup();
    map.current = m;
    // The tab bar, the install banner and rotation all change the map's box.
    const ro = new ResizeObserver(() => m.invalidateSize({ animate: false }));
    ro.observe(el.current);
    return () => {
      ro.disconnect();
      heat.current = null;
      m.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    if (visible) map.current?.invalidateSize({ animate: false });
  }, [visible]);

  useEffect(() => {
    const m = map.current;
    const group = layer.current;
    if (!m || !group) return;
    group.clearLayers();
    const points: L.LatLngExpression[] = [];
    // Drawn grey first and red last, so an alert is never hidden under another dot.
    const order = (s: TagSnapshot): number => (historyAt === null && alerting.has(s.tagId) ? 2 : checkedIn.has(s.tagId) ? 1 : 0);
    for (const snap of [...shown].sort((a, b) => order(a) - order(b))) {
      if (snap.lat === null || snap.lon === null) continue;
      points.push([snap.lat, snap.lon]);
      const isAlert = historyAt === null && alerting.has(snap.tagId);
      L.circleMarker([snap.lat, snap.lon], {
        radius: isAlert ? 9 : 7,
        color: '#12140f',
        weight: 2,
        fillColor: isAlert ? COLOR.alert : checkedIn.has(snap.tagId) ? COLOR.checkedIn : COLOR.notCheckedIn,
        fillOpacity: 0.95,
      })
        .on('click', () => onOpen.current(snap.tagId, historyAt !== null ? snap : undefined))
        .addTo(group);
    }
    // Frame the organisation's tags once; after that the map stays where it was
    // put. Only once this org's own data has loaded, not the previous org's
    // dots that are still on screen for a moment after a switch.
    if (fittedOrg.current !== orgId && data.loadedOrgId === orgId && points.length) {
      m.fitBounds(L.latLngBounds(points), { padding: [40, 40], maxZoom: 16, animate: false });
      fittedOrg.current = orgId;
    }
  }, [shown, checkedIn, alerting, historyAt, orgId, data.loadedOrgId]);

  // "Show on map": straight to the tag, no fly-over, with a short pulse so the
  // eye finds it.
  useEffect(() => {
    const m = map.current;
    if (!m || !focus) return;
    setHistoryAt(null);
    const snap = data.watched.find((r) => r.tagId === focus.tagId)?.snap ?? data.rows.find((r) => r.tagId === focus.tagId)?.snap;
    if (snap?.lat == null || snap.lon == null) return;
    m.invalidateSize({ animate: false });
    m.setView([snap.lat, snap.lon], Math.max(m.getZoom(), FOCUS_ZOOM), { animate: false });
    fittedOrg.current = orgId;

    pulse.current?.remove();
    pulse.current = L.marker([snap.lat, snap.lon], {
      icon: L.divIcon({ className: 'focus-pulse', iconSize: [44, 44] }),
      interactive: false,
      keyboard: false,
    }).addTo(m);
    const t = setTimeout(() => {
      pulse.current?.remove();
      pulse.current = null;
    }, 2400);
    return () => clearTimeout(t);
    // Only when a new focus is asked for, not whenever the rows refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.n]);

  const shownLinks = historyAt !== null ? (historyLinks ?? []) : data.links;
  const shownDevices = historyAt !== null ? (historyDevices ?? data.devices) : data.devices;

  // Heatmap: replaces the tag dots, as on the desktop. Recreated rather than
  // updated in place, which is how the desktop avoids leaflet.heat keeping
  // listeners on a map it was removed from.
  useEffect(() => {
    const m = map.current;
    const dots = layer.current;
    if (!m || !dots) return;
    if (heat.current) {
      m.removeLayer(heat.current);
      heat.current = null;
    }
    if (fns.heatmap) {
      if (m.hasLayer(dots)) m.removeLayer(dots);
      const points = (heatPoints ?? []).map((p): [number, number, number] => [p.lat, p.lon, 1]);
      for (const d of shownDevices) if (d.lat !== null && d.lon !== null) points.push([d.lat, d.lon, 1]);
      heat.current = L.heatLayer(points, HEATMAP_OPTIONS).addTo(m);
    } else if (!m.hasLayer(dots)) {
      dots.addTo(m);
    }
  }, [fns.heatmap, heatPoints, shownDevices]);

  // Geofences: the organisation's boundaries, under everything else.
  useEffect(() => {
    const m = map.current;
    const group = geofenceLayer.current;
    if (!m || !group) return;
    group.clearLayers();
    if (!fns.geofences || !geofences) {
      if (m.hasLayer(group)) m.removeLayer(group);
      return;
    }
    for (const fence of geofences) {
      if (fence.coordinates.length < 3) continue;
      L.polygon(fence.coordinates, {
        color: fence.color ?? '#E9AE2F',
        weight: 2,
        fillOpacity: 0.06,
        interactive: false,
        renderer: svgRenderer.current ?? undefined,
      }).addTo(group);
    }
    if (!m.hasLayer(group)) group.addTo(m);
    group.eachLayer((l) => {
      (l as L.Polygon).bringToBack();
    });
  }, [fns.geofences, geofences]);

  // Link view: a faint line from each reader (or the tag a reading relayed
  // through) to the tag it heard in the latest round, with a ball pushed along
  // it to show direction. Same rules as the desktop. The readers themselves
  // are drawn too, so every line has a visible start. Sits out while the
  // heatmap is on, which has no per-tag positions to link.
  const linksOn = fns.links && !fns.heatmap;
  useEffect(() => {
    const m = map.current;
    const group = linkLayer.current;
    const readers = deviceLayer.current;
    if (!m || !group || !readers) return;
    group.clearLayers();
    readers.clearLayers();
    balls.current = [];
    if (!linksOn) {
      if (m.hasLayer(group)) m.removeLayer(group);
      if (m.hasLayer(readers)) m.removeLayer(readers);
      return;
    }

    const byId = new Map(shown.map((t) => [t.tagId, t]));
    const anchorable = shownDevices.filter((d): d is DeviceRow & { lat: number; lon: number } => d.lat !== null && d.lon !== null);
    const byRadioId = new Map(anchorable.filter((d) => d.radioId !== null).map((d) => [d.radioId as string, d]));
    const byImei = new Map(anchorable.map((d) => [d.imei, d]));

    for (const reading of shownLinks) {
      const tag = byId.get(reading.tagId);
      if (!tag || tag.lat === null || tag.lon === null) continue;
      const relay = reading.linkId ? byId.get(reading.linkId) : undefined;
      let origin: { lat: number; lon: number } | undefined =
        relay && relay.lat !== null && relay.lon !== null
          ? { lat: relay.lat, lon: relay.lon }
          : reading.linkId
            ? byRadioId.get(reading.linkId)
            : undefined;
      origin ??= byImei.get(reading.sourceDeviceImei);
      if (!origin) continue;

      const from: [number, number] = [origin.lat, origin.lon];
      const to: [number, number] = [tag.lat, tag.lon];
      L.polyline([from, to], {
        color: LINK_COLOR,
        weight: 1.5,
        opacity: 0.3,
        interactive: false,
        renderer: svgRenderer.current ?? undefined,
      }).addTo(group);
      const ball = L.marker(from, {
        icon: L.divIcon({ className: 'link-ball-wrap', html: '<span class="link-ball"></span>', iconSize: [10, 10], iconAnchor: [5, 5] }),
        interactive: false,
        keyboard: false,
      }).addTo(group);
      balls.current.push({ from, to, ball });
    }

    for (const d of anchorable) {
      L.marker([d.lat, d.lon], { icon: deviceIcon(d.positionSource), zIndexOffset: 1000, keyboard: false })
        .bindTooltip(d.label ? `${d.label} · reader` : `Reader ${d.imei}`, { direction: 'top', offset: [0, -10] })
        .addTo(readers);
    }

    if (!m.hasLayer(group)) group.addTo(m);
    if (!m.hasLayer(readers)) readers.addTo(m);
  }, [linksOn, shown, shownLinks, shownDevices]);

  // The balls' animation runs only while the map is on screen.
  useEffect(() => {
    if (!linksOn || !visible) return;
    let frame = 0;
    const animate = (time: number): void => {
      const t = (time % LINK_PERIOD_MS) / LINK_PERIOD_MS;
      const eased = (1 - Math.cos(t * Math.PI)) / 2;
      const fade = t < 0.06 ? t / 0.06 : t > 0.94 ? (1 - t) / 0.06 : 1;
      for (const seg of balls.current) {
        seg.ball.setLatLng([seg.from[0] + (seg.to[0] - seg.from[0]) * eased, seg.from[1] + (seg.to[1] - seg.from[1]) * eased]);
        const ballEl = seg.ball.getElement();
        if (ballEl) ballEl.style.opacity = String(Math.max(0.06, fade));
      }
      frame = requestAnimationFrame(animate);
    };
    frame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frame);
  }, [linksOn, visible, shownLinks, shown, shownDevices]);

  const withFix = shown.some((s) => s.lat !== null);

  return (
    <div className="map-wrap">
      <div ref={el} className="map" />
      <div className="map-blocks">
      <CountBlock
        orgId={orgId}
        snapshots={shown}
        now={refNow}
        windowChoice={windowChoice}
        onWindowChange={setWindowChoice}
        historyAt={historyAt}
        onSelectHistory={setHistoryAt}
        onGoLive={() => setHistoryAt(null)}
        dataVersion={data.updatedAt}
        streamConnected={data.live}
      />
      {props.showFunctions && (
        <FunctionsBlock value={savedFunctions} onChange={setFunctions} geofenceCount={geofences ? geofences.length : null} heatCount={heatPoints ? heatPoints.length : null} />
      )}
      </div>
      {data.updatedAt !== null && !withFix && !fns.heatmap && <div className="map-note">No tag has a GPS fix to show.</div>}
    </div>
  );
}
