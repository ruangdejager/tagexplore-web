import {
  AGE_LABEL,
  BATTERY_LABEL,
  batteryColor,
  batteryLevel,
  batteryPercent,
  formatAge,
  positionAge,
  shortDeviceId,
  type DeviceRow,
  type TagSnapshot,
} from '@tagexplore/core';
import { alertText } from '../format.js';
import type { TagRow } from '../useOrgData.js';
import { Sheet } from './Sheet.js';

const MOVEMENT: Record<number, string> = { 0: 'moving', 1: 'still' };

function timestamp(ms: number): string {
  // Johannesburg time, the clock the devices and the people reading this both work on.
  return new Date(ms).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', hour12: false });
}

/**
 * One tag's card, with the same fields as the desktop tag card. `snap` overrides
 * the live reading while the map is showing a past round.
 */
export function TagSheet(props: {
  tagId: string;
  row: TagRow | null;
  snap?: TagSnapshot | undefined;
  devices: DeviceRow[];
  /** Hidden when the card was opened from the map itself. */
  onShowOnMap?: ((tagId: string) => void) | undefined;
  onClose: () => void;
}): JSX.Element {
  const { row } = props;
  const tag = props.snap ?? row?.snap ?? null;
  const now = props.snap ? props.snap.lastSeenAt : Date.now();
  const realNow = Date.now();
  const historic = props.snap !== undefined;

  return (
    <Sheet onClose={props.onClose} label={`Tag ${props.tagId}`}>
      <div className="sheet-head">
        <div>
          <div className="sheet-title">{props.tagId}</div>
          <div className="sheet-sub">{row?.label ?? tag?.label ?? (tag ? AGE_LABEL[positionAge(tag.fixAt, realNow)] : '')}</div>
        </div>
        {!historic && row?.alert && <span className="pill bad">{alertText(row.alert, realNow)}</span>}
        {historic && <span className="pill">Past round</span>}
        {row?.hidden && <span className="pill">Switched off</span>}
      </div>

      {!tag ? (
        <p className="empty">No reading from this tag in the last year.</p>
      ) : (
        <TagFacts tag={tag} devices={props.devices} now={historic ? now : realNow} />
      )}

      <div className="button-row">
        {props.onShowOnMap && tag?.lat != null && (
          <button className="primary" onClick={() => props.onShowOnMap!(props.tagId)}>
            Show on map
          </button>
        )}
        {tag?.lat != null && tag.lon != null && (
          <a
            className="secondary as-button"
            href={`https://www.google.com/maps/search/?api=1&query=${tag.lat},${tag.lon}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open in Maps
          </a>
        )}
      </div>
    </Sheet>
  );
}

function TagFacts({ tag, devices, now }: { tag: TagSnapshot; devices: DeviceRow[]; now: number }): JSX.Element {
  const device = devices.find((d) => d.imei === tag.sourceDeviceImei);
  const level = batteryLevel(tag.batteryMv);
  const pct = batteryPercent(tag.batteryMv);

  const rows: Array<[string, React.ReactNode]> = [
    ['Last seen', `${formatAge(now - tag.lastSeenAt)} ago`],
    [
      'Battery',
      <>
        <span style={{ color: batteryColor(tag.batteryMv) }}>
          {tag.batteryMv === null ? '—' : `${tag.batteryMv}mV`} · {BATTERY_LABEL[level]}
        </span>
        <span className="battery-bar">
          <span style={{ width: `${pct ?? 0}%`, background: batteryColor(tag.batteryMv) }} />
        </span>
      </>,
    ],
    ['Fix', tag.fixAt === null ? 'never reported' : `${formatAge(now - tag.fixAt)} ago`],
  ];
  if (tag.lat !== null && tag.lon !== null) rows.push(['Position', <span className="mono">{`${tag.lat.toFixed(6)}, ${tag.lon.toFixed(6)}`}</span>]);
  if (tag.gpsAgeSeconds !== null) rows.push(['Fix age', `${tag.gpsAgeSeconds}s at report`]);
  rows.push(['Signal', tag.rssi === null ? '—' : `${tag.rssi} dBm`]);
  if (tag.hops !== null) rows.push(['Hops', `${tag.hops}${tag.waveCount !== null ? ` · wave ${tag.waveCount}` : ''}`]);
  if (tag.movementState !== null) rows.push(['Movement', MOVEMENT[tag.movementState] ?? String(tag.movementState)]);
  if (tag.fwVersionPatch !== null) rows.push(['Firmware', `patch ${tag.fwVersionPatch}`]);
  rows.push(['Heard by', device?.label || shortDeviceId(tag.sourceDeviceImei)]);
  rows.push(['Rounds', `${tag.readingCount} in window`]);
  rows.push(['Reported', <span className="mono small">{timestamp(tag.lastSeenAt)}</span>]);

  return (
    <dl className="facts">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}
