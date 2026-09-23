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

/**
 * How a reader's readings arrive, as an admin sets it. `'auto'` decides from
 * whether the unit has actually pushed recently, which is what lets a fleet
 * migrate to push ingest without anyone visiting each device — and what makes
 * a unit whose modem goes quiet fall back to log scraping on its own.
 */
export type IngestMode = 'auto' | 'push' | 'scrape';

/**
 * Where the position on a `DeviceRow` came from, for the discovery it is being
 * shown with.
 *
 * - `own` — the reader's own fix, reported inside the applicability window
 * - `linked-tag` — no applicable own fix, so this is the position of the
 *   ordinary tag carried by the same animal, in that same discovery round
 * - `stale` — nothing applicable; this is the last position on record and must
 *   be rendered as not-applicable, never as current
 * - `none` — no position at all
 */
export type DevicePositionSource = 'own' | 'linked-tag' | 'stale' | 'none';

/** Where a learned identity's value came from. `'manual'` is a latch inference never writes through. */
export type IdentitySource = 'manual' | 'auto';

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
  /**
   * What an admin set. `effectiveIngestMode` is what it currently resolves
   * to — the two differ only while this is `'auto'`.
   */
  ingestMode: IngestMode;
  /** Newest pushed campaign's arrival time, or null if this reader has never pushed. */
  lastPushAt: number | null;
  /**
   * What `ingestMode` resolves to right now. Computed per request rather than
   * stored, because it depends on the clock and on the configured grace period.
   */
  effectiveIngestMode: 'push' | 'scrape';
  /** The mesh radio id this reader identifies itself as inside a tag's `RssiSrc` column. */
  radioId: string | null;
  radioIdSource: IdentitySource | null;
  /** The ordinary tag carried by the same animal as this reader. */
  carriedTagId: string | null;
  carriedTagSource: IdentitySource | null;
  /** Last time the identity inference ran for this reader — its own rate limit, across restarts. */
  identityCheckedAt: number | null;
  /**
   * The reader's own position, read off the events API rather than the
   * discovery logs (which never carry it) — or, when `positionSource` says so,
   * the carried tag's position standing in for it. Null until there has been
   * one of either.
   */
  lat: number | null;
  lon: number | null;
  gpsUpdatedAt: number | null;
  /**
   * Whether the position above actually applies to the discovery being shown.
   * A row that has not been through `resolveDevicePosition` reports `'stale'`
   * (or `'none'`), so an un-validated position renders greyed rather than
   * confidently wrong.
   */
  positionSource: DevicePositionSource;
  /** When the shown position was reported. Mirrors `gpsUpdatedAt`, kept separate so the two can diverge later. */
  positionAt: number | null;
  /** The carried tag the position came from, when `positionSource` is `'linked-tag'`. */
  positionTagId: string | null;
  /** The discovery time the position was judged against — what "±10 minutes of what?" resolved to. */
  discoveryAt: number | null;
  /** This reader's own firmware version, off its most recent round — null until it has reported one. */
  readerFw: string | null;
  createdAt: number;
}

/**
 * One accumulated guess at a reader's identity, with the evidence behind it —
 * what the admin panel shows when it is asked why a value was chosen, or why
 * none was.
 */
export interface DeviceIdentityCandidate {
  kind: 'radio' | 'carried';
  value: string;
  /** True only for a CBOR-reported `primaryDeviceId`, which is not a guess at all. */
  exact: boolean;
  rounds: number;
  score: number;
  /** The numbers behind the score. */
  evidence: Record<string, number> | null;
  firstSeenAt: number;
  lastSeenAt: number;
  /**
   * Why this candidate was not chosen — `'also-heard'`, `'too-few-rounds'`,
   * `'share-below-threshold'`, `'score-below-threshold'`, `'no-margin'`,
   * `'heard-better-elsewhere'`, `'is-a-radio-id'`, `'outranked-by-report'`,
   * `'implausible-rssi'` — or null when it was.
   */
  rejectedFor: string | null;
}

export interface OrgTagRow {
  orgId: string;
  tagId: string;
  label: string | null;
  /**
   * Switched off for the whole organisation — dropped from the map, from the
   * unique-tag count's denominator and from the alerts panel, for everyone who
   * looks at this org. Usually says "this one is known to be inactive", which
   * is a fact about the tag rather than a preference of whoever noticed.
   */
  hidden: boolean;
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

/** One tag's GPS fix at a point in time, for the movement-map replay. */
export interface TagPosition {
  tagId: string;
  lat: number;
  lon: number;
  t: number;
}

/**
 * A geofence boundary, read off a reader's own events feed (the discovery
 * logs never carry these) and cached per-organisation. `regionId` is the
 * Farmranger platform's own id for the region, not one of ours.
 */
export interface GeofenceRegion {
  regionId: string;
  name: string;
  /** Hex colour as the platform reports it, or null if it didn't send one. */
  color: string | null;
  /** `[lat, lon]` per vertex, in order — a closed polygon is implied. */
  coordinates: Array<[number, number]>;
}

/**
 * How a round's data reached us.
 *
 * `cbor` is the unit POSTing the campaign to us directly, `log` is us pulling
 * its syslog afterwards and scraping the same campaign back out of the text.
 * The two carry different quality of the same facts — an exact arrival clock
 * and a firmware-measured duration against a 15-minute bracket and an
 * inferred one — so which path a round came by is worth showing, not just
 * worth recording.
 */
export type DiscoverySource = 'log' | 'cbor';

/** One discovery round's unique-tag count — one row per bracket the org's devices reported at. */
export interface DiscoveryCountPoint {
  bracketAt: number;
  count: number;
  /**
   * How long the discovery campaign took.
   *
   * On a `cbor` round this is the firmware's own on-air measurement, reported
   * in the POST body. On a `log` round it is the older inference: how long
   * after `bracketAt` the round's slowest device finished, the round being
   * assumed to start exactly on the bracket. Null when no round timing is on
   * record for the bracket at all.
   */
  durationSeconds: number | null;
  /**
   * Exactly when the campaign's data reached the server, for a round that was
   * pushed to us. Null on a scraped round, which has no arrival time of its
   * own — all it has is the bracket its blocks were bucketed into.
   */
  receivedAt: number | null;
  /** `cbor` when any of the bracket's rounds was pushed — a push takes precedence. */
  source: DiscoverySource;
}

/** One reader's side of one discovery round, as stored. */
export interface DiscoveryRoundDetail {
  deviceImei: string;
  deviceLabel: string | null;
  tagCount: number;
  durationSeconds: number | null;
  unitBatteryMv: number | null;
  readerFw: string | null;
  timedOut: boolean;
  source: DiscoverySource;
  receivedAt: number | null;
  /** The pushed campaign's own receipt, when this reader's round came by CBOR. */
  post: DiscoveryPostDetail | null;
}

/** The CBOR body's own envelope, off the push receipt — not any one reading. */
export interface DiscoveryPostDetail {
  /** The reporting primary tag's LoRa id, as the firmware sent it (decimal). */
  primaryDeviceId: number;
  /** Unix seconds off the unit's own RTC when it accepted the campaign. */
  sessionUtc: number;
  /** 0 = advanced, 1 = basic. */
  mode: number;
  /** Packed `major*10000 + minor*100 + patch`; 0 when the primary predates the field. */
  primaryVersion: number;
  recordCount: number;
  byteCount: number;
}

/** One stored `readings` row of a discovery round, unaggregated. */
export interface DiscoveryReadingDetail {
  deviceImei: string;
  tagId: string;
  batteryMv: number | null;
  rssi: number | null;
  hops: number | null;
  waveCount: number | null;
  movementState: number | null;
  lat: number | null;
  lon: number | null;
  hasGps: boolean;
  fwVersionPatch: number | null;
  gpsAgeSeconds: number | null;
  linkId: string | null;
  source: DiscoverySource;
}

/**
 * Everything stored about one discovery round, per reader and per reading —
 * the raw material behind a single count-history row. Restricted to `dev` and
 * `admin` accounts: it is a diagnostic view of how the data arrived, not
 * something a client has any use for.
 */
export interface DiscoveryDetail {
  bracketAt: number;
  rounds: DiscoveryRoundDetail[];
  readings: DiscoveryReadingDetail[];
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
  /** The id of the tag this reading relayed through to reach the reader — the
   *  mesh's real next hop. Only on newer firmware; null when there was none. */
  linkId: string | null;
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

/**
 * One device's raw reading of one tag in the org's single most recent
 * discovery bracket — unlike `TagSnapshot`, which collapses a tag down to one
 * row org-wide, this keeps every reader that heard the tag that round, so a
 * tag overlapping two readers' range gets a link line drawn from each.
 */
export interface LinkReading {
  tagId: string;
  sourceDeviceImei: string;
  linkId: string | null;
  waveCount: number | null;
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
 * A user's own map toggles — saved against their account so they carry over to
 * the next login rather than resetting every session.
 *
 * Which *tags* are switched off is deliberately not here any more: that turned
 * out to be a statement about the tag ("this one is dead, stop counting it")
 * rather than about the viewer, so it lives on `OrgTagRow.hidden` and is
 * shared by everyone looking at that organisation. Which *devices* are
 * switched off is still per-user — that one really is "what I want to look at
 * right now".
 */
export interface UserPreferences {
  colorMode: 'age' | 'latestGps' | 'discovery';
  /** The organisation this user was last looking at — null if they've never picked one. */
  lastOrgId: string | null;
  /** Whether geofence boundaries are drawn on the map — off by default, unlike
   *  the heatmap and link-view toggles, this one is remembered. */
  geofencesView: boolean;
  /** Devices switched off in the main list — every reading that came in
   *  through one of these is excluded everywhere: the map, the tag list,
   *  the count fraction, and the count history. */
  hiddenDeviceImeis: string[];
}
