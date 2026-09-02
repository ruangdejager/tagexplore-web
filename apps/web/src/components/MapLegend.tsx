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
 * "Under 2h" reads better than "< 2h") — this legend is a compact key, not a
 * sentence.
 */
const AGE_LEGEND: Array<{ age: PositionAge; label: string }> = [
  { age: 'live', label: '< 2h' },
  { age: 'recent', label: '< 24h' },
  { age: 'stale', label: '< 3 days' },
  { age: 'old', label: '> 3 days' },
];

/**
 * Two legends sharing one corner, each also a button: click one to colour the
 * map by it, which dims the other rather than hiding it, so both keep
 * reminding you what they mean.
 */
export function MapLegend({ mode, onChange }: Props): JSX.Element {
  return (
    <div className="legend-stack">
      <button className="legend" data-active={mode === 'age' ? '1' : '0'} onClick={() => onChange('age')}>
        {AGE_LEGEND.map(({ age, label }) => (
          <div key={age}>
            <i style={{ background: AGE_COLOR[age] }} />
            {label}
          </div>
        ))}
      </button>
      <button className="legend" data-active={mode === 'latestGps' ? '1' : '0'} onClick={() => onChange('latestGps')}>
        <div>
          <i style={{ background: AGE_COLOR.live }} />
          Live
        </div>
        <div>
          <i style={{ background: AGE_COLOR.none }} />
          Stale
        </div>
      </button>
    </div>
  );
}
