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
        <dd>{device.radioId ?? '—'}</dd>

        <dt>Firmware</dt>
        <dd>{device.readerFw ?? '—'}</dd>

        <dt>Fix</dt>
        <dd>{device.gpsUpdatedAt === null ? 'never reported' : `${formatAge(now - device.gpsUpdatedAt)} ago`}</dd>

        {device.gpsUpdatedAt !== null && (
          <>
            <dt>Reported</dt>
            <dd style={{ fontSize: 11 }}>{timestamp(device.gpsUpdatedAt)}</dd>
          </>
        )}
      </dl>
    </div>
  );
}
