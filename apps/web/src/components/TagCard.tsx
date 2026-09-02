import {
  AGE_LABEL,
  BATTERY_LABEL,
  batteryColor,
  batteryLevel,
  formatAge,
  positionAge,
  shortDeviceId,
  type DeviceRow,
  type TagSnapshot,
} from '@tagexplore/core';

interface Props {
  tag: TagSnapshot;
  devices: DeviceRow[];
  now: number;
  onClose: () => void;
  onShowTrend: (tagId: string) => void;
}

const MOVEMENT: Record<number, string> = { 0: 'moving', 1: 'still' };

function timestamp(ms: number): string {
  // Johannesburg time, because that is the clock the devices and the people
  // reading this both work on — not the browser's, which may be anywhere.
  return new Date(ms).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', hour12: false });
}

export function TagCard({ tag, devices, now, onClose, onShowTrend }: Props): JSX.Element {
  const device = devices.find((d) => d.imei === tag.sourceDeviceImei);
  const level = batteryLevel(tag.batteryMv);
  const age = positionAge(tag.fixAt, now);

  return (
    <div className="card">
      <h3>
        {tag.tagId}
        <button className="card-close pill" onClick={onClose} aria-label="Close">
          ×
        </button>
      </h3>
      <div className="sub">{tag.label ?? AGE_LABEL[age]}</div>

      <dl>
        <dt>Last seen</dt>
        <dd>{formatAge(now - tag.lastSeenAt)} ago</dd>

        <dt>Battery</dt>
        <dd style={{ color: batteryColor(tag.batteryMv) }}>
          {tag.batteryMv === null ? '—' : `${tag.batteryMv}mV`} · {BATTERY_LABEL[level]}
        </dd>

        <dt>Fix</dt>
        <dd>{tag.fixAt === null ? 'never reported' : `${formatAge(now - tag.fixAt)} ago`}</dd>

        {tag.lat !== null && tag.lon !== null && (
          <>
            <dt>Position</dt>
            <dd>
              {tag.lat.toFixed(6)}, {tag.lon.toFixed(6)}
            </dd>
          </>
        )}

        {tag.gpsAgeSeconds !== null && (
          <>
            <dt>Fix age</dt>
            <dd>{tag.gpsAgeSeconds}s at report</dd>
          </>
        )}

        <dt>Signal</dt>
        <dd>{tag.rssi === null ? '—' : `${tag.rssi} dBm`}</dd>

        {tag.hops !== null && (
          <>
            <dt>Hops</dt>
            <dd>
              {tag.hops}
              {tag.waveCount !== null && ` · wave ${tag.waveCount}`}
            </dd>
          </>
        )}

        {tag.movementState !== null && (
          <>
            <dt>Movement</dt>
            <dd>{MOVEMENT[tag.movementState] ?? tag.movementState}</dd>
          </>
        )}

        {tag.fwVersionPatch !== null && (
          <>
            <dt>Firmware</dt>
            <dd>patch {tag.fwVersionPatch}</dd>
          </>
        )}

        <dt>Heard by</dt>
        <dd>{device?.label || shortDeviceId(tag.sourceDeviceImei)}</dd>

        <dt>Rounds</dt>
        <dd>{tag.readingCount} in window</dd>

        <dt>Reported</dt>
        <dd style={{ fontSize: 11 }}>{timestamp(tag.lastSeenAt)}</dd>
      </dl>

      <div className="card-actions">
        <button className="pill" onClick={() => onShowTrend(tag.tagId)}>
          Battery trend
        </button>
        {tag.lat !== null && tag.lon !== null && (
          <a
            className="pill"
            style={{ textAlign: 'center', textDecoration: 'none' }}
            href={`https://www.google.com/maps/search/?api=1&query=${tag.lat},${tag.lon}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open in maps
          </a>
        )}
      </div>
    </div>
  );
}
