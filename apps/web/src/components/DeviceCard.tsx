import type { DeviceRow } from '@tagexplore/core';

interface Props {
  device: DeviceRow;
  onClose: () => void;
}

/** Metadata for one reader — the map's click-to-inspect for devices, same corner and card styling as a tag's. */
export function DeviceCard({ device, onClose }: Props): JSX.Element {
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
      </dl>
    </div>
  );
}
