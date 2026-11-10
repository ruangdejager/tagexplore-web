import L from 'leaflet';
import { distanceToGeofenceEdge, geofenceLabelPoint, type GeofenceRegion } from '@tagexplore/core';

/**
 * The count bubble inside each geofence, and the name label above it in
 * highlight view. Kept in step with apps/web/src/geofenceBubbles.ts.
 *
 * The bubble is at most `MAX_SIZE` across, and shrinks as the map zooms out
 * so it never reaches the geofence's edge: it stops `EDGE_GAP` pixels short
 * of the nearest edge. Zooming back in grows it again, up to `MAX_SIZE`.
 */
export const MAX_SIZE = 38;
const EDGE_GAP = 4;
/** Below this the number no longer fits, so the bubble is a plain dot. */
const MIN_TEXT_SIZE = 16;
const M_PER_DEG_LAT = 110_540;

export interface BubbleSpec {
  regionId: string;
  name: string;
  color: string;
  count: number;
  center: L.LatLng;
  /** Metres from `center` to the geofence's nearest edge. */
  edgeMeters: number;
}

export function bubbleSpec(fence: GeofenceRegion, count: number, color: string): BubbleSpec | null {
  const point = geofenceLabelPoint(fence.coordinates);
  if (!point) return null;
  return {
    regionId: fence.regionId,
    name: fence.name,
    color,
    count,
    center: L.latLng(point[0], point[1]),
    edgeMeters: distanceToGeofenceEdge(point, fence.coordinates),
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export class GeofenceBubbleLayer {
  private items: Array<{ spec: BubbleSpec; marker: L.Marker; label: L.Marker | null; size: number }> = [];

  constructor(
    private readonly map: L.Map,
    private readonly opts: {
      /** The pane the bubbles go in — one under the tag markers. */
      pane: string;
      /** Whether the bubble itself takes clicks (it can't under a canvas). */
      interactive: boolean;
      onBubbleClick: (regionId: string) => void;
      onExit: () => void;
    },
  ) {
    map.on('zoomend', this.resize, this);
  }

  destroy(): void {
    this.map.off('zoomend', this.resize, this);
  }

  /** Redraws the bubbles into `group`; `highlightId` also gets its name label. */
  set(group: L.LayerGroup, specs: BubbleSpec[], highlightId: string | null): void {
    this.items = [];
    for (const spec of specs) {
      const size = this.sizeFor(spec);
      const marker = L.marker(spec.center, {
        icon: this.bubbleIcon(spec, size),
        pane: this.opts.pane,
        interactive: this.opts.interactive,
        keyboard: false,
      });
      if (this.opts.interactive) marker.on('click', () => this.opts.onBubbleClick(spec.regionId));
      marker.addTo(group);
      let label: L.Marker | null = null;
      if (spec.regionId === highlightId) {
        label = L.marker(spec.center, { icon: this.labelIcon(spec, size), zIndexOffset: 2000, keyboard: false });
        label.on('click', (e: L.LeafletMouseEvent) => {
          // Keeps the map's own click handler from treating this as a click on the map.
          L.DomEvent.stopPropagation(e);
          if ((e.originalEvent.target as Element | null)?.closest('[data-exit]')) this.opts.onExit();
        });
        label.addTo(group);
      }
      this.items.push({ spec, marker, label, size });
    }
  }

  /** The bubble under a container point, for a map whose bubbles can't take clicks themselves. */
  hit(point: L.Point): string | null {
    for (const it of this.items) {
      if (this.map.latLngToContainerPoint(it.spec.center).distanceTo(point) <= Math.max(it.size, 12) / 2 + 2) {
        return it.spec.regionId;
      }
    }
    return null;
  }

  get count(): number {
    return this.items.length;
  }

  private resize(): void {
    for (const it of this.items) {
      const size = this.sizeFor(it.spec);
      if (size === it.size) continue;
      it.size = size;
      it.marker.setIcon(this.bubbleIcon(it.spec, size));
      it.label?.setIcon(this.labelIcon(it.spec, size));
    }
  }

  /** The bubble's diameter at the current zoom: as big as fits short of the edge, capped at MAX_SIZE. */
  private sizeFor(spec: BubbleSpec): number {
    const a = this.map.latLngToContainerPoint(spec.center);
    const b = this.map.latLngToContainerPoint([spec.center.lat + spec.edgeMeters / M_PER_DEG_LAT, spec.center.lng]);
    const radius = a.distanceTo(b);
    return Math.max(4, Math.min(MAX_SIZE, Math.floor(2 * (radius - EDGE_GAP))));
  }

  private bubbleIcon(spec: BubbleSpec, size: number): L.DivIcon {
    const border = Math.max(1.5, Math.round(size * 0.105 * 2) / 2);
    const font = Math.max(9, Math.round(size * 0.37));
    const text = size >= MIN_TEXT_SIZE ? String(spec.count) : '';
    return L.divIcon({
      className: 'geofence-count-wrap',
      html:
        `<span class="geofence-count" style="width:${size}px;height:${size}px;` +
        `border-color:${spec.color};border-width:${border}px;font-size:${font}px">${text}</span>`,
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
    });
  }

  private labelIcon(spec: BubbleSpec, size: number): L.DivIcon {
    return L.divIcon({
      className: 'geofence-name-wrap',
      html:
        `<div class="geofence-name" style="bottom:${Math.round(size / 2 + 6)}px;border-color:${spec.color}">` +
        `<span>${escapeHtml(spec.name)}</span><button type="button" data-exit>Exit view</button></div>`,
      iconSize: [0, 0],
      iconAnchor: [0, 0],
    });
  }
}
