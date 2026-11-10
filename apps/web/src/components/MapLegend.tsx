import { AGE_COLOR, DISCOVERY_WINDOWS, GPS_FIX_COLOR, GPS_FIX_LEGEND, type DiscoveryWindow } from '@tagexplore/core';
import type { MarkerColorMode } from './MapView.js';

interface Props {
  mode: MarkerColorMode;
  onChange: (mode: MarkerColorMode) => void;
  /** The count panel's own dropdown — "Gps state" ages its Live/Stale split
   *  off the same window rather than a fixed one, so the legend's label
   *  needs it too. */
  gpsWindow: DiscoveryWindow;
}

/**
 * Three legends sharing one corner, each also a button: click one to colour
 * the map by it, which dims the others rather than hiding them, so all three
 * keep reminding you what they mean. Discovery state's own colours double up
 * on GPS state's (green/grey) — what differs is which tags earn green: a
 * fresh GPS fix there, membership in the count panel's checked-in set here.
 */
export function MapLegend({ mode, onChange, gpsWindow }: Props): JSX.Element {
  const gpsWindowLabel = DISCOVERY_WINDOWS.find((w) => w.value === gpsWindow)?.label ?? '';
  return (
    <div className="legend-stack">
      <button className="legend" data-active={mode === 'age' ? '1' : '0'} onClick={() => onChange('age')}>
        <div className="legend-title">Gps age</div>
        {/* "No fix" has no row: a tag without one has no marker to colour. */}
        {GPS_FIX_LEGEND.map(({ band, label }) => (
          <div key={band}>
            <i style={{ background: GPS_FIX_COLOR[band] }} />
            {label}
          </div>
        ))}
      </button>
      <button className="legend" data-active={mode === 'latestGps' ? '1' : '0'} onClick={() => onChange('latestGps')}>
        <div className="legend-title">Gps state · {gpsWindowLabel}</div>
        <div>
          <i style={{ background: AGE_COLOR.live }} />
          Live
        </div>
        <div>
          <i style={{ background: AGE_COLOR.none }} />
          Stale
        </div>
      </button>
      <button className="legend" data-active={mode === 'discovery' ? '1' : '0'} onClick={() => onChange('discovery')}>
        <div className="legend-title">Discovery state</div>
        <div>
          <i style={{ background: AGE_COLOR.live }} />
          Checked in
        </div>
        <div>
          <i style={{ background: AGE_COLOR.none }} />
          Out of range
        </div>
      </button>
    </div>
  );
}
