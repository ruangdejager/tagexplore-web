import { formatAge, type DeviceRow } from '@tagexplore/core';

interface Props {
  device: DeviceRow;
  now: number;
  onClose: () => void;
}

function timestamp(ms: number): string {
  // Johannesburg time, same convention as the tag card.
  return new Date(ms).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', hour12: false });
}

/**
 * What the reader's position actually is, for the discovery being shown.
 *
 * The distinction this makes is the whole point of the row: a fix from four
 * hours before the round is not this round's position, and saying "4h ago" as
 * though it were invites exactly the wrong conclusion about where the reader
 * was. So an inapplicable fix is labelled as such and dimmed, with the gap
 * spelled out underneath.
 */
function FixValue({ device, now }: { device: DeviceRow; now: number }): JSX.Element {
  if (device.positionSource === 'linked-tag') {
    return (
      <dd>
        via tag {device.positionTagId}
        <div className="position-note">the reader's own fix was not from this round</div>
      </dd>
    );
  }

  if (device.positionSource === 'stale') {
    return (
      <dd className="position-stale">
        not applicable
        {device.positionAt !== null && device.discoveryAt !== null && (
          <div className="position-note">
            last fix {formatAge(Math.abs(device.discoveryAt - device.positionAt))}{' '}
            {device.positionAt < device.discoveryAt ? 'before' : 'after'} this round
          </div>
        )}
      </dd>
    );
  }

  if (device.gpsUpdatedAt === null) return <dd>never reported</dd>;
  return <dd>{formatAge(now - device.gpsUpdatedAt)} ago</dd>;
}

/** Metadata for one reader — the map's click-to-inspect for devices, same corner and card styling as a tag's. */
export function DeviceCard({ device, now, onClose }: Props): JSX.Element {
  return (
    <div className="card">
      <h3>
        {device.label || 'Reader'}
        <button className="card-close pill" onClick={onClose} aria-label="Close">
          ×
        </button>
      </h3>
      <div className="sub">{device.active ? 'active' : 'inactive'}</div>

      <dl>
        <dt>IMEI</dt>
        <dd>{device.imei}</dd>

        {device.label && (
          <>
            <dt>Label</dt>
            <dd>{device.label}</dd>
          </>
        )}

        <dt>Radio ID</dt>
        <dd>
          {device.radioId ?? '—'}
          {device.radioIdSource === 'auto' && <span className="identity-badge">auto</span>}
        </dd>

        <dt>Carried tag</dt>
        {/* An em dash is "not known"; "none" is someone having said this
            reader carries no tag. Same blank column, opposite meanings. */}
        <dd>
          {device.carriedTagId ?? (device.carriedTagSource === 'manual' ? 'none' : '—')}
          {device.carriedTagSource === 'auto' && <span className="identity-badge">auto</span>}
        </dd>

        <dt>Firmware</dt>
        <dd>{device.readerFw ?? '—'}</dd>

        <dt>Fix</dt>
        <FixValue device={device} now={now} />

        {device.gpsUpdatedAt !== null && (
          <>
            <dt>Reported</dt>
            <dd style={{ fontSize: 11 }} className={device.positionSource === 'stale' ? 'position-stale' : undefined}>
              {timestamp(device.gpsUpdatedAt)}
            </dd>
          </>
        )}
      </dl>
    </div>
  );
}
