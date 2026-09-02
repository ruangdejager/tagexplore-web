/**
 * The wire contract between the API and the web app. Both import these from
 * core, so a field that changes shape breaks the type check on both sides at
 * once instead of at runtime in a browser.
 */

/**
 * Access levels.
 *
 * `admin` manages organisations, users, devices and each org's tag whitelist.
 * `user` sees only its own organisation's whitelisted tags. The Telegram bot's
 * dev/client split is deliberately not modelled yet — there is no behavioural
 * difference to gate on until the feature set settles — but it lands here as
 * an extra level rather than a new concept when it does.
 */
export type UserRole = 'user' | 'admin';

export interface AuthUser {
  id: string;
  username: string;
  role: UserRole;
  /** Null only for an admin who hasn't been placed in an organisation. */
  orgId: string | null;
  orgName: string | null;
}

export interface OrganisationRow {
  id: string;
  name: string;
  createdAt: number;
  userCount: number;
  deviceCount: number;
  tagCount: number;
}

export interface DeviceRow {
  /** The device IMEI — its identity everywhere, including in the logs API. */
  imei: string;
  orgId: string;
  orgName: string | null;
  label: string;
  active: boolean;
  /**
   * The device's own daily report schedule, as the settings API describes it:
   * a bounded series of `reportCountPerDay` reports, the first at
   * `reportStartMinute` minutes past local midnight and each one
   * `reportIntervalMinutes` after the last. The defaults describe the fleet's
   * current setting — 19 reports from 04:10, hourly, so 04:10 through 22:10.
   */
  reportStartMinute: number;
  reportIntervalMinutes: number;
  reportCountPerDay: number;
  /** How long after a report to wait before reading the log it produced. */
  pollOffsetMinutes: number;
  lastIngestAt: number | null;
  lastIngestStatus: string | null;
  createdAt: number;
}

export interface OrgTagRow {
  orgId: string;
  tagId: string;
  label: string | null;
  createdAt: number;
  /** Last time this tag appeared in any of the org's devices' logs, if ever. */
  lastSeenAt: number | null;
}

/** A tag ID seen in the logs that is not on any organisation's whitelist. */
export interface UnclaimedTagRow {
  tagId: string;
  deviceImei: string;
  orgId: string;
  orgName: string | null;
  lastSeenAt: number;
  readingCount: number;
}

/** Latest known state of one tag — one row in the sidebar, one pin on the map. */
export interface TagSnapshot {
  tagId: string;
  label: string | null;
  /** Most recent reading of any kind, GPS or not. */
  lastSeenAt: number;
  batteryMv: number | null;
  rssi: number | null;
  hops: number | null;
  waveCount: number | null;
  movementState: number | null;
  fwVersionPatch: number | null;
  /** The device whose log carried the most recent reading. */
  sourceDeviceImei: string;
  /** Most recent GPS-carrying reading. Null when the tag has never reported a fix. */
  lat: number | null;
  lon: number | null;
  /** When that fix was reported. Null when there has never been one. */
  fixAt: number | null;
  /** Seconds between the fix being taken and reported, when the firmware says. */
  gpsAgeSeconds: number | null;
  /** Distinct discovery rounds this tag appeared in, over the requested window. */
  readingCount: number;
}

export interface BatteryPoint {
  t: number;
  mv: number;
}

export interface BatterySeries {
  tagId: string;
  label: string | null;
  points: BatteryPoint[];
}

export interface IngestRunRow {
  id: number;
  deviceImei: string;
  startedAt: number;
  finishedAt: number | null;
  /** `ok`, `error`, or `running`. */
  status: string;
  blocksParsed: number;
  readingsWritten: number;
  error: string | null;
}
