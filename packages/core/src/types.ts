/** One tag's readings inside a single discovery block, as parsed off a device's log. */
export interface TagReading {
  /** 1-4 printable-ASCII characters, uppercased. */
  id: string;
  /** Mesh hops back to the reading device. Only present in "advanced" mode logs. */
  hops: number | null;
  /** Discovery wave index. Only present in "advanced" mode logs. */
  waveCount: number | null;
  rssi: number;
  /** Millivolts. */
  battery: number;
  movementState: number | null;
  /** Decimal degrees, or null when the tag reported no usable fix. */
  lat: number | null;
  lon: number | null;
  hasGps: boolean;
  /** The tag's own firmware patch level, distinct from the reading device's version. */
  fwVersionPatch: number | null;
  /** Seconds between the fix being taken and it being reported. Only in "basic" mode. */
  gpsAgeSeconds: number | null;
  /**
   * The id of the tag this one's data actually relayed through to reach the
   * reader — the mesh's real next hop, distinct from `hops`' plain count. Only
   * on newer firmware; null when the column is absent, blank, or `0` (the
   * firmware's own "no link yet" value).
   */
  linkId: string | null;
}

/** One `*HH:MM:SS(+02:00)` discovery block from one device's log. */
export interface DiscoveryBlock {
  unitId: string;
  /** ISO 8601 with the device's own UTC offset, e.g. `2026-07-22T09:01:47+02:00`. */
  timestamp: string;
  /** `DD-Mon-YYYY`, as printed in the log. */
  date: string;
  /** `HH:MM:SS`, as printed in the log. */
  time: string;
  /** The reading device's own supply voltage at the time of the block, in mV. */
  unitBatteryMv: number | null;
  /** True when the device logged `LOG TIMEOUT` instead of a tag table. */
  isTimeout: boolean;
  tags: TagReading[];
  /** The device's own "Total devices discovered" count, before any filtering. */
  total: number;
  /** The reading device's firmware version, when the log names it. */
  readerFwVersion?: string | null;
}

/** A tag reading merged into a session, tracking which device actually saw it. */
export interface SessionTag extends TagReading {
  sourceUnitId: string;
}

/** A discovery round: every block from every device that rounds to the same bracket. */
export interface DiscoverySession {
  /** Bracket boundary, ISO 8601 in Africa/Johannesburg. */
  timestamp: string;
  date: string;
  time: string;
  /** True when no device produced a usable reading for this bracket. */
  discarded: boolean;
  involvedUnitIds: string[];
  tags: SessionTag[];
  /** Unique tag count across every device in the round. */
  total: number;
  perDeviceTotals: Record<string, number>;
  perDeviceFwVersion: Record<string, string>;
  /** Seconds from the bracket boundary to the slowest device's first good block. */
  durationSeconds: number;
}

/** A bracket where every device timed out — no data, but worth surfacing. */
export interface DiscardedSession {
  timestamp: string;
  date: string;
  time: string;
  discarded: true;
  timeoutUnitIds: string[];
  involvedUnitIds: string[];
}

export type MergedSession = DiscoverySession | DiscardedSession;

export function isDiscarded(session: MergedSession): session is DiscardedSession {
  return session.discarded;
}
