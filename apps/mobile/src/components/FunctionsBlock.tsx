import { usePref } from '../prefs.js';
import { MinimiseButton } from './CountBlock.js';

export interface MapFunctions {
  geofences: boolean;
  links: boolean;
  heatmap: boolean;
}

export const NO_MAP_FUNCTIONS: MapFunctions = { geofences: false, links: false, heatmap: false };

/** Hours of GPS fixes the heatmap shows. Fixed on the phone; the desktop has a picker. */
export const HEATMAP_HOURS = 7 * 24;

/**
 * "Map functions", under the count block: the organisation's geofences, link
 * view and a 7-day heatmap, each switched on or off. Minimises to a pill the
 * same width as the count block's pill; tap the pill to open it again.
 */
export function FunctionsBlock(props: { value: MapFunctions; onChange: (v: MapFunctions) => void; geofenceCount: number | null; heatCount: number | null }): JSX.Element {
  const [minimised, setMinimised] = usePref('tx-m-functions-minimised', false);
  const on = Object.values(props.value).filter(Boolean).length;

  if (minimised) {
    return (
      <button type="button" className="map-block map-block-mini" onClick={() => setMinimised(false)} aria-label="Show map functions">
        <svg className="mini-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path d="M2 4.5h12M2 8h12M2 11.5h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <circle cx="5" cy="4.5" r="1.6" fill="currentColor" />
          <circle cx="11" cy="8" r="1.6" fill="currentColor" />
          <circle cx="7" cy="11.5" r="1.6" fill="currentColor" />
        </svg>
        <span className="mini-label strong">Map functions</span>
        {on > 0 && <span className="mini-count">{on}</span>}
      </button>
    );
  }

  const set = (key: keyof MapFunctions) => (checked: boolean) => props.onChange({ ...props.value, [key]: checked });

  return (
    <div className="map-block functions-block">
      <div className="block-head">
        <span className="block-title">Map functions</span>
        <MinimiseButton label="Minimise map functions" onClick={() => setMinimised(true)} />
      </div>
      <Toggle
        label="Geofences"
        note={props.value.geofences && props.geofenceCount === 0 ? 'None for this organisation' : undefined}
        checked={props.value.geofences}
        onChange={set('geofences')}
      />
      <Toggle
        label="Link view"
        note={props.value.links && props.value.heatmap ? 'Hidden while the heatmap is on' : undefined}
        checked={props.value.links}
        onChange={set('links')}
      />
      <Toggle
        label="Heatmap"
        note={props.value.heatmap && props.heatCount === 0 ? 'No GPS fixes in the last 7 days' : 'Last 7 days'}
        checked={props.value.heatmap} onChange={set('heatmap')} />
    </div>
  );
}

function Toggle(props: { label: string; note?: string | undefined; checked: boolean; onChange: (v: boolean) => void }): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      className="fn-toggle"
      onClick={() => props.onChange(!props.checked)}
    >
      <span className="fn-text">
        <span>{props.label}</span>
        {props.note && <small>{props.note}</small>}
      </span>
      <span className="switch-track" data-on={props.checked ? '1' : '0'}>
        <span />
      </span>
    </button>
  );
}
