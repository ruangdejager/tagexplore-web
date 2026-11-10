import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet.heat';
import 'leaflet/dist/leaflet.css';
import {
  allocateTagsToGeofences,
  checkedInTagIds,
  DISCOVERY_WINDOWS,
  geofenceAreaSquareMeters,
  geofenceLabelPoint,
  geofenceStats,
  GPS_FIX_COLOR,
  GPS_FIX_LEGEND,
  gpsFixBand,
  pointInGeofence,
  type GeofenceStats,
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
import { FunctionsBlock, HEATMAP_HOURS, NO_MAP_FUNCTIONS, normaliseMapFunctions, type MapFunctions } from './FunctionsBlock.js';

/** Outline colour for a geofence the feed sent without one. */
const GEOFENCE_DEFAULT_COLOR = '#E9AE2F';
/** Tags outside the highlighted geofence. */
const DIMMED_COLOR = '#5A5E58';
const BUBBLE_SIZE = 38;

/** A geofence's count bubble: grey, white number, a thick brim in the geofence's own colour. */
function geofenceCountIcon(count: number, color: string): L.DivIcon {
  return L.divIcon({
    className: 'geofence-count-wrap',
    html: `<span class="geofence-count" style="border-color:${color}">${count}</span>`,
    iconSize: [BUBBLE_SIZE, BUBBLE_SIZE],
    iconAnchor: [BUBBLE_SIZE / 2, BUBBLE_SIZE / 2],
  });
}
const SOUTH_AFRICA: [number, number] = [-28.8, 24.5];
const FOCUS_ZOOM = 17;
/** Same look as the desktop heatmap, so the two read the same density the same way. */
const HEATMAP_OPTIONS: L.HeatMapOptions = { radius: 12, blur: 10, max: 11, minOpacity: 0.08 };
const LINK_COLOR = '#4FBF8B';
/** One push of the ball along a link line, origin to tag, as on the desktop. */
const LINK_PERIOD_MS = 2000;

function deviceIcon(source: DeviceRow['positionSource'], dimmed = false): L.DivIcon {
  const variant = source === 'stale' ? ' stale' : source === 'linked-tag' ? ' via-tag' : '';
  return L.divIcon({
    className: `device-marker-wrap${variant}${dimmed ? ' dimmed' : ''}`,
    html: '<span class="device-marker-ping"></span><span class="device-marker-dot"></span>',
    iconSize: [20, 20],
    iconAnchor: [10, 10],
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
 * Dots carry no labels; tapping one opens the tag's card. Colour is the age of
 * the tag's GPS fix (see `gpsFixBand`, and the Legend button); a tag in alert
 * is drawn larger, with a white ring, on top of the others.
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
  /** The organisation's geofences, switched on in Settings. Independent of Map functions. */
  showGeofences: boolean;
  /** Only for `dev` and `admin` accounts: opens a history round's raw data. */
  onShowRaw?: ((bracketAt: number) => void) | undefined;
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

  const [storedFunctions, setFunctions] = usePref<MapFunctions>('tx-m-map-functions', NO_MAP_FUNCTIONS);
  const savedFunctions = normaliseMapFunctions(storedFunctions);
  const fns = props.showFunctions ? savedFunctions : NO_MAP_FUNCTIONS;
  const showGeofences = props.showGeofences;
  const [geofences, setGeofences] = useState<GeofenceRegion[] | null>(null);
  const [heatPoints, setHeatPoints] = useState<GpsPoint[] | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [legendOpen, setLegendOpen] = useState(false);
  /** The geofence whose count bubble was tapped, for its info box. */
  const [geofencePopup, setGeofencePopup] = useState<string | null>(null);
  /** The geofence in highlight view: only it is drawn, everything outside greys out. */
  const [highlightRegionId, setHighlightRegionId] = useState<string | null>(null);
  const onBubble = useRef<(regionId: string) => void>(() => undefined);
  onBubble.current = (regionId) => setGeofencePopup(regionId);

  useEffect(() => setNow(Date.now()), [data.updatedAt]);
  useEffect(() => {
    setHistoryAt(null);
    setHighlightRegionId(null);
    setGeofencePopup(null);
  }, [orgId]);

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
    if (!showGeofences || geofences !== null) return;
    let cancelled = false;
    api
      .fetchGeofences(orgId)
      .then((res) => !cancelled && setGeofences(res.geofences))
      .catch(() => !cancelled && setGeofences([]));
    return () => {
      cancelled = true;
    };
  }, [showGeofences, geofences, orgId]);

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
  const roundDevices = historyAt !== null ? (historyDevices ?? data.devices) : data.devices;

  // Every shown tag lands in a geofence automatically (see
  // `allocateTagsToGeofences`), and each geofence's bubble counts what the
  // count block counts — same as the desktop.
  const geofenceInfo = useMemo(() => {
    if (!geofences || geofences.length === 0) return null;
    const allocations = allocateTagsToGeofences(shown, roundDevices, geofences, windowChoice, refNow);
    return geofenceStats(allocations, geofences, checkedIn);
  }, [geofences, shown, roundDevices, windowChoice, refNow, checkedIn]);
  const highlightFence =
    highlightRegionId !== null ? (geofences?.find((g) => g.regionId === highlightRegionId) ?? null) : null;
  const highlightTagIds = useMemo(
    () => (highlightRegionId !== null ? (geofenceInfo?.get(highlightRegionId)?.tagIds ?? new Set<string>()) : null),
    [highlightRegionId, geofenceInfo],
  );
  const latestRoundIds = useMemo(() => checkedInTagIds(shown, 'latest', refNow), [shown, refNow]);

  useEffect(() => {
    if (!el.current) return;
    const m = L.map(el.current, { zoomControl: false, attributionControl: true }).setView(SOUTH_AFRICA, 5);
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19,
      attribution: 'Esri, Maxar',
    }).addTo(m);
    svgRenderer.current = L.svg({ padding: 0.5 });
    // Under the overlay pane (400) the tag dots draw in, so a tag is always on
    // top of a geofence's count bubble. The SVG pane only takes taps on its
    // own shapes, so a bubble is still tappable wherever no dot covers it.
    m.createPane('geofenceCounts').style.zIndex = '390';
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
    // Dimmed first, alerts last, so an alert is never hidden under another dot.
    const order = (s: TagSnapshot): number =>
      highlightTagIds && !highlightTagIds.has(s.tagId) ? 0 : historyAt === null && alerting.has(s.tagId) ? 2 : 1;
    for (const snap of [...shown].sort((a, b) => order(a) - order(b))) {
      if (snap.lat === null || snap.lon === null) continue;
      points.push([snap.lat, snap.lon]);
      const isAlert = historyAt === null && alerting.has(snap.tagId);
      const dimmed = highlightTagIds !== null && !highlightTagIds.has(snap.tagId);
      L.circleMarker([snap.lat, snap.lon], {
        radius: isAlert ? 7 : 5.5,
        color: isAlert && !dimmed ? '#ffffff' : '#12140f',
        weight: isAlert && !dimmed ? 2 : 1.5,
        opacity: dimmed ? 0.4 : 1,
        fillColor: dimmed ? DIMMED_COLOR : GPS_FIX_COLOR[gpsFixBand(snap, latestRoundIds, refNow)],
        fillOpacity: dimmed ? 0.35 : 0.95,
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
  }, [shown, latestRoundIds, refNow, alerting, historyAt, orgId, data.loadedOrgId, highlightTagIds]);

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
      icon: L.divIcon({ className: 'focus-pulse', iconSize: [36, 36] }),
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
    if ((!showGeofences && !highlightFence) || !geofences) {
      if (m.hasLayer(group)) m.removeLayer(group);
      return;
    }
    // Highlight view shows its own geofence and nothing else.
    for (const fence of highlightFence ? [highlightFence] : geofences) {
      if (fence.coordinates.length < 3) continue;
      L.polygon(fence.coordinates, {
        color: fence.color ?? GEOFENCE_DEFAULT_COLOR,
        weight: 2,
        fillOpacity: 0.06,
        interactive: false,
        renderer: svgRenderer.current ?? undefined,
      }).addTo(group);
      const count = geofenceInfo?.get(fence.regionId)?.counted;
      const centre = count === undefined ? null : geofenceLabelPoint(fence.coordinates);
      if (count !== undefined && centre) {
        L.marker(centre, {
          icon: geofenceCountIcon(count, fence.color ?? GEOFENCE_DEFAULT_COLOR),
          pane: 'geofenceCounts',
          keyboard: false,
        })
          .on('click', () => onBubble.current(fence.regionId))
          .addTo(group);
      }
    }
    if (!m.hasLayer(group)) group.addTo(m);
    group.eachLayer((l) => {
      if (l instanceof L.Polygon) l.bringToBack();
    });
  }, [showGeofences, geofences, geofenceInfo, highlightFence]);

  // Link view: a faint line from each reader (or the tag a reading relayed
  // through) to the tag it heard in the latest round, with a ball pushed along
  // it to show direction. Same rules as the desktop. The readers themselves
  // are drawn too, so every line has a visible start. Sits out while the
  // heatmap is on (the two are exclusive anyway).
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
      // In highlight view only the geofence's own tags pulse.
      const outsideHighlight = highlightTagIds !== null && !highlightTagIds.has(tag.tagId);
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
        opacity: outsideHighlight ? 0.1 : 0.3,
        interactive: false,
        renderer: svgRenderer.current ?? undefined,
      }).addTo(group);
      if (outsideHighlight) continue;
      const ball = L.marker(from, {
        icon: L.divIcon({ className: 'link-ball-wrap', html: '<span class="link-ball"></span>', iconSize: [10, 10], iconAnchor: [5, 5] }),
        interactive: false,
        keyboard: false,
      }).addTo(group);
      balls.current.push({ from, to, ball });
    }

    for (const d of anchorable) {
      const dimmed = highlightFence !== null && !pointInGeofence([d.lat, d.lon], highlightFence.coordinates);
      L.marker([d.lat, d.lon], { icon: deviceIcon(d.positionSource, dimmed), zIndexOffset: 1000, keyboard: false })
        .bindTooltip(d.label ? `${d.label} · reader` : `Reader ${d.imei}`, { direction: 'top', offset: [0, -10] })
        .addTo(readers);
    }

    if (!m.hasLayer(group)) group.addTo(m);
    if (!m.hasLayer(readers)) readers.addTo(m);
  }, [linksOn, shown, shownLinks, shownDevices, highlightTagIds, highlightFence]);

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
        onShowRaw={props.onShowRaw}
        dataVersion={data.updatedAt}
        streamConnected={data.live}
      />
      {props.showFunctions && (
        <FunctionsBlock value={savedFunctions} onChange={setFunctions} heatCount={heatPoints ? heatPoints.length : null} />
      )}
      </div>
      {data.updatedAt !== null && !withFix && !fns.heatmap && <div className="map-note">No tag has a GPS fix to show.</div>}

      {highlightFence && (
        <div className="highlight-bar">
          <span>
            Highlighting <b>{highlightFence.name}</b>
          </span>
          <button type="button" onClick={() => setHighlightRegionId(null)}>
            Exit highlight view
          </button>
        </div>
      )}

      {!fns.heatmap && (
        <button type="button" className="legend-button" onClick={() => setLegendOpen((v) => !v)} aria-expanded={legendOpen}>
          Legend <span className="legend-i">i</span>
        </button>
      )}
      {legendOpen && (
        <div className="map-popup legend-popup" role="dialog" aria-label="Legend">
          <div className="map-popup-head">
            <strong>GPS fix</strong>
            <button type="button" className="map-popup-x" aria-label="Close" onClick={() => setLegendOpen(false)}>
              ×
            </button>
          </div>
          <ul className="legend-list">
            {GPS_FIX_LEGEND.map(({ band, label }) => (
              <li key={band}>
                <i style={{ background: GPS_FIX_COLOR[band] }} />
                {label}
              </li>
            ))}
            <li>
              <i className="legend-alert-ring" />
              In alert (larger, white ring)
            </li>
          </ul>
        </div>
      )}

      {geofencePopup !== null && (
        <GeofencePopup
          fence={geofences?.find((g) => g.regionId === geofencePopup) ?? null}
          stats={geofenceInfo?.get(geofencePopup) ?? null}
          readersInside={
            shownDevices.filter((d) => {
              const fence = geofences?.find((g) => g.regionId === geofencePopup);
              return fence && d.lat !== null && d.lon !== null && pointInGeofence([d.lat, d.lon], fence.coordinates);
            }).length
          }
          windowLabel={DISCOVERY_WINDOWS.find((w) => w.value === windowChoice)?.label ?? ''}
          highlighted={highlightRegionId === geofencePopup}
          onHighlight={(on) => {
            setHighlightRegionId(on ? geofencePopup : null);
            setGeofencePopup(null);
          }}
          onClose={() => setGeofencePopup(null)}
        />
      )}
    </div>
  );
}


/** The box a geofence's count bubble opens: its name, how its tags were placed, and highlight view. */
function GeofencePopup(props: {
  fence: GeofenceRegion | null;
  stats: GeofenceStats | null;
  readersInside: number;
  windowLabel: string;
  highlighted: boolean;
  onHighlight: (on: boolean) => void;
  onClose: () => void;
}): JSX.Element | null {
  const { fence, stats } = props;
  if (!fence) return null;
  const hectares = geofenceAreaSquareMeters(fence.coordinates) / 10_000;
  const rows: Array<[string, string | number]> = [
    [`Counted · ${props.windowLabel}`, stats?.counted ?? 0],
    ['Tags placed here', stats?.placed ?? 0],
    ['Inside the boundary', stats?.inside ?? 0],
    ['Nearest geofence (just outside)', stats?.nearest ?? 0],
    ['By tag GPS / by reader', `${stats?.byTagGps ?? 0} / ${stats?.byReader ?? 0}`],
    ...((stats?.shared ?? 0) > 0 ? [['Also in an overlapping geofence', stats!.shared] as [string, number]] : []),
    ['Readers inside', props.readersInside],
    ['Area', `${hectares >= 100 ? Math.round(hectares).toLocaleString('en-ZA') : hectares.toFixed(1)} ha`],
  ];
  return (
    <div className="map-popup geofence-popup" role="dialog" aria-label={fence.name}>
      <div className="map-popup-head">
        <i className="geofence-swatch" style={{ background: fence.color ?? GEOFENCE_DEFAULT_COLOR }} aria-hidden="true" />
        <strong>{fence.name}</strong>
        <button type="button" className="map-popup-x" aria-label="Close" onClick={props.onClose}>
          ×
        </button>
      </div>
      <dl className="map-popup-facts">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <button type="button" className="primary" onClick={() => props.onHighlight(!props.highlighted)}>
        {props.highlighted ? 'Exit highlight view' : 'Highlight devices'}
      </button>
    </div>
  );
}
