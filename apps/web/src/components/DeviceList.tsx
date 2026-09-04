import { shortDeviceId, type DeviceRow } from '@tagexplore/core';

interface Props {
  devices: DeviceRow[];
  selectedDeviceImei: string | null;
  onSelect: (imei: string) => void;
  /** Devices switched off — every reading that came in through one is
   *  excluded everywhere: the map, the tag list, the counts, and the
   *  history. The devices themselves still show here, just dimmed. */
  hiddenDeviceImeis: Set<string>;
  onToggle: (imei: string) => void;
}

/**
 * Sits above the tag list, same row styling — readers are toggled the same
 * way tags are hidden from the map, except a device's toggle reaches further:
 * off means none of its readings count anywhere, not just off the map.
 */
export function DeviceList({ devices, selectedDeviceImei, onSelect, hiddenDeviceImeis, onToggle }: Props): JSX.Element | null {
  if (devices.length === 0) return null;

  return (
    <div className="list device-list">
      {devices.map((device) => {
        const enabled = !hiddenDeviceImeis.has(device.imei);
        return (
          <div
            key={device.imei}
            className="row device-row"
            role="button"
            tabIndex={0}
            aria-selected={device.imei === selectedDeviceImei}
            onClick={() => onSelect(device.imei)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelect(device.imei);
              }
            }}
          >
            <button
              className="row-visibility"
              data-on={enabled ? '1' : '0'}
              title={enabled ? 'Exclude this device — hides everything it reported' : 'Include this device again'}
              onClick={(e) => {
                e.stopPropagation();
                onToggle(device.imei);
              }}
            />
            <span className="bar" style={{ background: device.active ? '#4FBF8B' : 'var(--ink-dim)' }} />
            <span className="sn">{device.label || `Reader ${shortDeviceId(device.imei)}`}</span>
          </div>
        );
      })}
    </div>
  );
}
