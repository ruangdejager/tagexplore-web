import { useEffect, useMemo, useState } from 'react';
import type { BatterySeries, OrgTagRow } from '@tagexplore/core';
import * as api from '../api.js';

interface Props {
  orgId: string | null;
  tags: OrgTagRow[];
  /** Tags the user has switched on. Owned by the parent so the map can add to it. */
  selected: Set<string>;
  onToggle: (tagId: string) => void;
  onSelectOnly: (tagIds: string[]) => void;
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

export function BatteryTrends({ orgId, tags, selected, onToggle, onSelectOnly }: Props): JSX.Element {
  const [from, setFrom] = useState(() => toDateInput(Date.now() - 7 * 86_400_000));
  const [to, setTo] = useState(() => toDateInput(Date.now()));
  const [series, setSeries] = useState<BatterySeries[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const selectedIds = useMemo(() => [...selected].sort(), [selected]);
  const key = selectedIds.join(',');

  useEffect(() => {
    if (!orgId || selectedIds.length === 0) {
      setSeries([]);
      return;
    }

    let cancelled = false;
    setLoading(true);
    api
      .fetchBattery(orgId, fromDateInput(from, false), fromDateInput(to, true), selectedIds)
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
    <footer>
      <div className="trend-head">
        <span className="title">Battery over time</span>
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
        <TrendChart series={series} colorFor={colorFor} />
        <div className="trend-toggles">
          {tags.length === 0 && <div className="empty" style={{ padding: '8px 0' }}>No tags on this whitelist yet.</div>}
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
    </footer>
  );
}

const PAD = { top: 10, right: 12, bottom: 20, left: 40 };
const VIEW = { width: 900, height: 190 };

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
  const points = series.flatMap((s) => s.points);
  if (points.length === 0) {
    return (
      <div className="empty" style={{ padding: '30px 0' }}>
        Switch a tag on to chart its battery, and set the date range you want to look at.
      </div>
    );
  }

  const minT = Math.min(...points.map((p) => p.t));
  const maxT = Math.max(...points.map((p) => p.t));
  const rawMin = Math.min(...points.map((p) => p.mv));
  const rawMax = Math.max(...points.map((p) => p.mv));
  // Round the voltage axis out to 50mV steps with a little headroom, so a flat
  // series does not collapse onto a single line at the top of the box.
  const minMv = Math.floor((rawMin - 20) / 50) * 50;
  const maxMv = Math.ceil((rawMax + 20) / 50) * 50;

  const plotWidth = VIEW.width - PAD.left - PAD.right;
  const plotHeight = VIEW.height - PAD.top - PAD.bottom;
  const x = (t: number): number => PAD.left + (maxT === minT ? plotWidth / 2 : ((t - minT) / (maxT - minT)) * plotWidth);
  const y = (mv: number): number => PAD.top + (1 - (mv - minMv) / (maxMv - minMv || 1)) * plotHeight;

  const gridLines = 4;
  const ticks = Array.from({ length: gridLines + 1 }, (_, i) => minMv + ((maxMv - minMv) / gridLines) * i);
  const dateLabel = (ms: number): string =>
    new Date(ms).toLocaleDateString('en-ZA', { timeZone: 'Africa/Johannesburg', day: '2-digit', month: 'short' });

  return (
    <svg className="chart" viewBox={`0 0 ${VIEW.width} ${VIEW.height}`} role="img">
      {ticks.map((mv) => (
        <g key={mv}>
          <line className="grid" x1={PAD.left} x2={VIEW.width - PAD.right} y1={y(mv)} y2={y(mv)} opacity={0.5} />
          <text x={PAD.left - 6} y={y(mv) + 3} textAnchor="end">
            {Math.round(mv)}
          </text>
        </g>
      ))}

      <line className="axis" x1={PAD.left} x2={PAD.left} y1={PAD.top} y2={VIEW.height - PAD.bottom} />
      <text x={PAD.left} y={VIEW.height - 6}>
        {dateLabel(minT)}
      </text>
      <text x={VIEW.width - PAD.right} y={VIEW.height - 6} textAnchor="end">
        {dateLabel(maxT)}
      </text>

      {series.map((s) => (
        <polyline
          key={s.tagId}
          className="series"
          stroke={colorFor(s.tagId)}
          points={s.points.map((p) => `${x(p.t)},${y(p.mv)}`).join(' ')}
        />
      ))}
    </svg>
  );
}
