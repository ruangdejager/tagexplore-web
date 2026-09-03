import { AGE_COLOR, type PositionAge } from '@tagexplore/core';
import type { MarkerColorMode } from './MapView.js';

interface Props {
  mode: MarkerColorMode;
  onChange: (mode: MarkerColorMode) => void;
}

/**
 * "No fix" is a real tag state, but never a marker — that tag has no position
 * to plot — so it has no place in a legend of marker colours. Shorter than
 * core's own AGE_LABEL (which is also used in running prose elsewhere, where
 * "Under 4h" reads better than "< 4h") — this legend is a compact key, not a
 * sentence.
 */
const AGE_LEGEND: Array<{ age: PositionAge; label: string }> = [
  { age: 'live', label: '< 4h' },
  { age: 'recent', label: '< 12h' },
  { age: 'stale', label: '< 24h' },
  { age: 'old', label: '> 24h' },
];

/**
 * Three legends sharing one corner, each also a button: click one to colour
 * the map by it, which dims the others rather than hiding them, so all three
 * keep reminding you what they mean. Discovery state's own colours double up
 * on GPS state's (green/grey) — what differs is which tags earn green: a
 * fresh GPS fix there, membership in the count panel's checked-in set here.
 */
export function MapLegend({ mode, onChange }: Props): JSX.Element {
  return (
    <div className="legend-stack">
      <button className="legend" data-active={mode === 'age' ? '1' : '0'} onClick={() => onChange('age')}>
        <div className="legend-title">Gps age</div>
        {AGE_LEGEND.map(({ age, label }) => (
          <div key={age}>
            <i style={{ background: AGE_COLOR[age] }} />
            {label}
          </div>
        ))}
      </button>
      <button className="legend" data-active={mode === 'latestGps' ? '1' : '0'} onClick={() => onChange('latestGps')}>
        <div className="legend-title">Gps state</div>
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
