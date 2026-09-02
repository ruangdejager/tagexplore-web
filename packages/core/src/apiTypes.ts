/**
 * The wire contract between the API and the web app. Both import these from
 * core, so a field that changes shape breaks the type check on both sides at
 * once instead of at runtime in a browser.
 */

/**
 * Access levels.
 *
 * `client` and `dev` both see only their own organisation's whitelisted tags —
 * identical access today, kept as separate labels because they're expected to
 * diverge once the feature set that would separate them exists. `admin` has
 * that same org-scoped access, plus the admin panel: organisations, users,
 * devices, whitelists and pending access requests.
 */
export type UserRole = 'client' | 'dev' | 'admin';

export interface AuthUser {
  id: string;
  username: string;
  role: UserRole;
  /**
   * Every organisation this account is assigned to — a user can belong to
   * several. Empty for a non-admin not yet placed in any. An admin's own
   * membership here is irrelevant: admins see every organisation regardless
   * of what's listed, this is just their own explicit memberships if any.
   */
  orgs: Array<{ id: string; name: string }>;
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

export type OrgAccessRequestStatus = 'pending' | 'approved' | 'rejected';

/** A user's ask to be placed in an organisation, and an admin's answer to it. */
export interface OrgAccessRequestRow {
  id: number;
  userId: string;
  username: string;
  orgId: string;
  orgName: string | null;
  status: OrgAccessRequestStatus;
  createdAt: number;
}

/** One point of a stored GPS fix, for the density heatmap. */
export interface GpsPoint {
  lat: number;
  lon: number;
}

/** One discovery round's unique-tag count — one row per bracket the org's devices reported at. */
export interface DiscoveryCountPoint {
  bracketAt: number;
  count: number;
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

/**
 * A user's own map toggles — which tags are switched off in the main list,
 * and which marker-colour legend is active — saved against their account so
 * they carry over to the next login rather than resetting every session.
 */
export interface UserPreferences {
  hiddenTagIds: string[];
  colorMode: 'age' | 'latestGps';
}
