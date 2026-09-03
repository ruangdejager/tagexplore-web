import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BATTERY_GOOD_MIN,
  BATTERY_LOW_MIN,
  BATTERY_OK_MIN,
  BATTERY_COLOR,
  type BatterySeries,
  type OrgTagRow,
} from '@tagexplore/core';
import * as api from '../api.js';

interface Props {
  orgId: string | null;
  tags: OrgTagRow[];
  /** Tags the user has switched on in the chart's own toggle list. */
  selected: Set<string>;
  onToggle: (tagId: string) => void;
  onSelectOnly: (tagIds: string[]) => void;
  /** Owned by the parent so a tag card's "Battery trend" button can expand
   *  this panel itself, not just pick which tag it shows. */
  expanded: boolean;
  onToggleExpanded: () => void;
}

/**
 * A qualitative palette, not a scale: these lines are unordered categories, so
 * the colours only need to stay apart from each other and off the age/battery
 * colours the rest of the app uses to mean something.
 */
const SERIES_COLORS = [
  '#4FBF8B',
  '#E9AE2F',
  '#3E9AD8',
  '#C77DFF',
  '#E2731B',
  '#7FD1C1',
  '#D96F8E',
  '#A3C959',
  '#9AA0FF',
  '#D9C36F',
];

export function seriesColor(index: number): string {
  return SERIES_COLORS[index % SERIES_COLORS.length] as string;
}

/** `YYYY-MM-DD` for a date input, in Johannesburg time rather than the browser's. */
function toDateInput(ms: number): string {
  return new Date(ms + 2 * 3_600_000).toISOString().slice(0, 10);
}

/** Reads a date input back as Johannesburg midnight (or the end of that day). */
function fromDateInput(value: string, endOfDay: boolean): number {
  const base = Date.parse(`${value}T00:00:00+02:00`);
  return endOfDay ? base + 86_400_000 - 1 : base;
}

export function BatteryTrends({
  orgId,
  tags,
  selected,
  onToggle,
  onSelectOnly,
  expanded,
  onToggleExpanded,
}: Props): JSX.Element {
  const [from, setFrom] = useState(() => toDateInput(Date.now() - 7 * 86_400_000));
  const [to, setTo] = useState(() => toDateInput(Date.now()));
  const [series, setSeries] = useState<BatterySeries[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const selectedIds = useMemo(() => [...selected].sort(), [selected]);
  const key = selectedIds.join(',');

  useEffect(() => {
    if (selectedIds.length === 0 || !orgId) {
      setSeries([]);
      return;
    }

    const rangeFrom = fromDateInput(from, false);
    const rangeTo = fromDateInput(to, true);

    let cancelled = false;
    setLoading(true);
    api
      .fetchBattery(orgId, rangeFrom, rangeTo, selectedIds)
      .then((res) => {
        if (cancelled) return;
        setSeries(res.series);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load battery history.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // `key` stands in for selectedIds: an array identity changes every render,
    // its contents do not.
  }, [orgId, from, to, key]);

  // Colour is assigned by position in the whitelist, not in the response, so a
  // tag keeps the same colour as others are switched on and off.
  const colorFor = useMemo(() => {
    const index = new Map(tags.map((t, i) => [t.tagId, i]));
    return (tagId: string): string => seriesColor(index.get(tagId) ?? 0);
  }, [tags]);

  const latestByTag = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of series) {
      const last = s.points[s.points.length - 1];
      if (last) map.set(s.tagId, last.mv);
    }
    return map;
  }, [series]);

  return (
    <footer data-expanded={expanded ? '1' : '0'}>
      <button
        className="footer-pull"
        onClick={onToggleExpanded}
        title={expanded ? 'Hide battery panel' : 'Show battery panel'}
      >
        <span className="panel-title" style={{ padding: 0 }}>
          Battery over time
        </span>
        <span className="chevron">{expanded ? '▾' : '▴'}</span>
      </button>

      {expanded && (
        <div className="trend-panel">
          <div className="trend-head">
            <div className="trend-controls">
              <label>
                from <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
              </label>
              <label>
                to <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
              </label>
              <button className="pill" onClick={() => onSelectOnly(tags.map((t) => t.tagId))}>
                All tags
              </button>
              <button className="pill" onClick={() => onSelectOnly([])}>
                None
              </button>
              <span>
                {loading ? 'loading…' : `${series.length} of ${tags.length} shown`}
                {error && <span className="status-error"> · {error}</span>}
              </span>
            </div>
          </div>

          <div className="trend-body">
            <div className="chart-column">
              {/* Remounts (and so resets any zoom) whenever the date range changes —
                  a new range is a new view, not a continuation of the old one. */}
              <TrendChart key={`${from}|${to}`} series={series} colorFor={colorFor} />
            </div>
            <div className="trend-toggles">
              {tags.length === 0 && (
                <div className="empty" style={{ padding: '8px 0' }}>
                  No tags on this whitelist yet.
                </div>
              )}
              {tags.map((tag) => {
                const on = selected.has(tag.tagId);
                const mv = latestByTag.get(tag.tagId);
                return (
                  <button
                    key={tag.tagId}
                    className="trend-toggle"
                    data-on={on ? '1' : '0'}
                    onClick={() => onToggle(tag.tagId)}
                    title={on ? 'Hide this tag' : 'Show this tag'}
                  >
                    <span className="swatch" style={{ background: colorFor(tag.tagId) }} />
                    <span>{tag.tagId}</span>
                    {tag.label && <span style={{ opacity: 0.7 }}>{tag.label}</span>}
                    {on && mv !== undefined && <span className="mv">{mv}mV</span>}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </footer>
  );
}

const PAD = { top: 10, right: 12, bottom: 20, left: 40 };
const VIEW = { width: 900, height: 190 };

/**
 * The Y axis (mV) is fixed, not data-driven — 3350 at the bottom, 4200 at the
 * top when fully zoomed out — because the point of this chart is to compare a
 * reading against fleet-wide thresholds, not to auto-fit whatever happened to
 * be selected. Scrolling zooms it toward the cursor, down to a 100mV window;
 * it can never see outside [AXIS_LO, AXIS_HI] regardless of zoom or pan.
 */
const AXIS_LO = 3350;
const AXIS_HI = 4200;
const MAX_SPAN = AXIS_HI - AXIS_LO;
const MIN_SPAN = 100;
/** Where the chart opens and what "Reset zoom" returns to — the band most readings actually live in. */
const DEFAULT_VIEW: [number, number] = [3800, 4000];
/** Multiplier per wheel notch — keeps zooming feeling steady regardless of trackpad vs. wheel deltas. */
const ZOOM_FACTOR = 0.85;

/** Fixed reference lines at the app's own battery thresholds, so the chart reads the same as every other battery colour in the app. */
const THRESHOLD_LINES: Array<{ mv: number; color: string }> = [
  { mv: BATTERY_LOW_MIN, color: BATTERY_COLOR.critical },
  { mv: BATTERY_OK_MIN, color: BATTERY_COLOR.ok },
  { mv: BATTERY_GOOD_MIN, color: BATTERY_COLOR.good },
];

/** Gridline spacing narrows as the visible span narrows — 200mV at the widest view down to 25mV at the tightest, in round steps. */
function gridSpacingFor(span: number): number {
  if (span > 600) return 200;
  if (span > 300) return 100;
  if (span > 150) return 50;
  return 25;
}

/** Keeps a [min, max] window inside [AXIS_LO, AXIS_HI] by sliding it, not by squashing its span. */
function clampWindow(min: number, max: number): [number, number] {
  const span = Math.min(max - min, MAX_SPAN);
  let newMin = min;
  let newMax = min + span;
  if (newMin < AXIS_LO) {
    newMin = AXIS_LO;
    newMax = AXIS_LO + span;
  }
  if (newMax > AXIS_HI) {
    newMax = AXIS_HI;
    newMin = AXIS_HI - span;
  }
  return [newMin, newMax];
}

/**
 * A plain SVG line chart rather than a charting library: the shape needed here
 * is one polyline per series on a shared linear scale, and drawing it directly
 * keeps the bundle small and the styling consistent with the rest of the app.
 * The viewBox does the scaling, so it stays sharp at any panel width.
 */
function TrendChart({
  series,
  colorFor,
}: {
  series: BatterySeries[];
  colorFor: (tagId: string) => string;
}): JSX.Element {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [[viewMin, viewMax], setView] = useState<[number, number]>(DEFAULT_VIEW);

  const plotWidth = VIEW.width - PAD.left - PAD.right;
  const plotHeight = VIEW.height - PAD.top - PAD.bottom;
  const y = (mv: number): number => PAD.top + (1 - (mv - viewMin) / (viewMax - viewMin)) * plotHeight;

  // Native listener, not onWheel: React attaches wheel handlers passively by
  // default, which would silently swallow preventDefault and let the page
  // scroll under the chart while it zoomed.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const svgY = ((e.clientY - rect.top) / rect.height) * VIEW.height;
      const t = Math.min(1, Math.max(0, (svgY - PAD.top) / plotHeight));

      setView(([min, max]) => {
        const mvUnderCursor = min + (max - min) * (1 - t);
        const span = Math.min(MAX_SPAN, Math.max(MIN_SPAN, (max - min) * (e.deltaY < 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR)));
        const newMin = mvUnderCursor - span * (1 - t);
        return clampWindow(newMin, newMin + span);
      });
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [plotHeight]);

  const points = series.flatMap((s) => s.points);
  const zoomed = viewMin !== DEFAULT_VIEW[0] || viewMax !== DEFAULT_VIEW[1];

  const spacing = gridSpacingFor(viewMax - viewMin);
  const ticks: number[] = [];
  for (let mv = Math.ceil(viewMin / spacing) * spacing; mv <= viewMax; mv += spacing) ticks.push(mv);

  let minT = 0;
  let maxT = 0;
  if (points.length > 0) {
    minT = Math.min(...points.map((p) => p.t));
    maxT = Math.max(...points.map((p) => p.t));
  }
  const x = (t: number): number => PAD.left + (maxT === minT ? plotWidth / 2 : ((t - minT) / (maxT - minT)) * plotWidth);
  const dateLabel = (ms: number): string =>
    new Date(ms).toLocaleDateString('en-ZA', { timeZone: 'Africa/Johannesburg', day: '2-digit', month: 'short' });

  return (
    <div className="chart-wrap">
      <svg className="chart" ref={svgRef} viewBox={`0 0 ${VIEW.width} ${VIEW.height}`} role="img">
        {ticks.map((mv) => (
          <g key={mv}>
            <line className="grid" x1={PAD.left} x2={VIEW.width - PAD.right} y1={y(mv)} y2={y(mv)} opacity={0.5} />
            <text x={PAD.left - 6} y={y(mv) + 3} textAnchor="end">
              {Math.round(mv)}
            </text>
          </g>
        ))}

        {THRESHOLD_LINES.filter((t) => t.mv >= viewMin && t.mv <= viewMax).map((t) => (
          <line
            key={t.mv}
            className="threshold"
            stroke={t.color}
            x1={PAD.left}
            x2={VIEW.width - PAD.right}
            y1={y(t.mv)}
            y2={y(t.mv)}
          />
        ))}

        <line className="axis" x1={PAD.left} x2={PAD.left} y1={PAD.top} y2={VIEW.height - PAD.bottom} />

        {points.length > 0 && (
          <>
            <text x={PAD.left} y={VIEW.height - 6}>
              {dateLabel(minT)}
            </text>
            <text x={VIEW.width - PAD.right} y={VIEW.height - 6} textAnchor="end">
              {dateLabel(maxT)}
            </text>
          </>
        )}

        {series.map((s) => (
          <polyline
            key={s.tagId}
            className="series"
            stroke={colorFor(s.tagId)}
            points={s.points.map((p) => `${x(p.t)},${y(p.mv)}`).join(' ')}
          />
        ))}
      </svg>

      {points.length === 0 && (
        <div className="empty chart-empty">
          Switch a tag on to chart its battery, and set the date range you want to look at.
        </div>
      )}

      {zoomed && (
        <button className="pill chart-reset-zoom" onClick={() => setView(DEFAULT_VIEW)}>
          Reset zoom
        </button>
      )}
    </div>
  );
}
