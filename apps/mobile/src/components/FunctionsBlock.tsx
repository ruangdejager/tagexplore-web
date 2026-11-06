import { usePref } from '../prefs.js';
import { MinimiseButton } from './CountBlock.js';

/** Link view and the heatmap. At most one is on: they never show together. */
export interface MapFunctions {
  links: boolean;
  heatmap: boolean;
}

export const NO_MAP_FUNCTIONS: MapFunctions = { links: false, heatmap: false };

/**
 * A stored setting from before the two became exclusive may have both on (and
 * a `geofences` field, which now lives in Settings). Link view wins then.
 */
export function normaliseMapFunctions(v: MapFunctions): MapFunctions {
  return { links: Boolean(v.links), heatmap: Boolean(v.heatmap) && !v.links };
}

/** Hours of GPS fixes the heatmap shows. Fixed on the phone; the desktop has a picker. */
export const HEATMAP_HOURS = 7 * 24;

/**
 * "Map functions", under the count block: link view or a 7-day heatmap.
 * Switching one on switches the other off. Minimises to a pill the same width
 * as the count block's pill; tap the pill to open it again.
 */
export function FunctionsBlock(props: { value: MapFunctions; onChange: (v: MapFunctions) => void; heatCount: number | null }): JSX.Element {
  const [minimised, setMinimised] = usePref('tx-m-functions-minimised', false);
  const active = props.value.links ? 'Link view' : props.value.heatmap ? 'Heatmap' : null;

  if (minimised) {
    return (
      <button type="button" className="map-block map-block-mini" onClick={() => setMinimised(false)} aria-label="Show map functions">
        <svg className="mini-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path d="M2 4.5h12M2 8h12M2 11.5h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <circle cx="5" cy="4.5" r="1.6" fill="currentColor" />
          <circle cx="11" cy="8" r="1.6" fill="currentColor" />
          <circle cx="7" cy="11.5" r="1.6" fill="currentColor" />
        </svg>
        <span className="mini-label strong">{active ?? 'Map functions'}</span>
      </button>
    );
  }

  return (
    <div className="map-block functions-block">
      <div className="block-head">
        <span className="block-title">Map functions</span>
        <MinimiseButton label="Minimise map functions" onClick={() => setMinimised(true)} />
      </div>
      <Toggle
        label="Link view"
        checked={props.value.links}
        onChange={(on) => props.onChange({ links: on, heatmap: on ? false : props.value.heatmap })}
      />
      <Toggle
        label="Heatmap"
        note={props.value.heatmap && props.heatCount === 0 ? 'No GPS fixes in the last 7 days' : 'Last 7 days'}
        checked={props.value.heatmap}
        onChange={(on) => props.onChange({ heatmap: on, links: on ? false : props.value.links })}
      />
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
