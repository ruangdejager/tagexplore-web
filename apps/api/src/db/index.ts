import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import type {
  BatterySeries,
  DeviceRow,
  DiscoveryCountPoint,
  GeofenceRegion,
  GpsPoint,
  IngestRunRow,
  OrgAccessRequestRow,
  OrgTagRow,
  OrganisationRow,
  TagPosition,
  TagSnapshot,
  UnclaimedTagRow,
  UserRole,
} from '@tagexplore/core';

/**
 * Storage.
 *
 * `node:sqlite` ships with Node itself, so there is no native module to
 * compile — `npm install` works the same on a Windows laptop as in a slim
 * Docker image, and the runtime image needs no toolchain.
 *
 * It is loaded through `createRequire` rather than a static import because
 * esbuild's built-in list predates `node:sqlite`: it strips the `node:` prefix
 * on the way out, and a bare `sqlite` specifier doesn't resolve, so the bundled
 * server builds cleanly and then dies on startup. Resolving it at runtime keeps
 * the specifier intact. The type import above is erased at compile time, so it
 * costs nothing and we keep full type checking.
 */
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: typeof DatabaseSyncType;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS organisations (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL
);

-- org_id is legacy -- a user now belongs to zero or more organisations via
-- user_orgs below, backfilled from this column on first boot after the
-- change (see migrateUserOrgs). Left in place rather than dropped: it's dead
-- weight, but node:sqlite has no clean ALTER TABLE DROP COLUMN path worth the
-- risk for a column nothing reads or writes any more.
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'client',
  org_id        TEXT REFERENCES organisations(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL
);

-- A user can be assigned to several organisations (an admin implicitly sees
-- all of them regardless of what's listed here — this table is about which
-- organisations a *non-admin* account may pick from).
CREATE TABLE IF NOT EXISTS user_orgs (
  user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id   TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, org_id)
);

CREATE INDEX IF NOT EXISTS user_orgs_org ON user_orgs(org_id);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

-- A user with no organisation asks to be placed in one; an admin approves or
-- rejects it. The partial unique index (not a plain UNIQUE on user_id) is what
-- lets a rejected request be followed by a fresh one, while still stopping a
-- second pending request from piling up behind the first.
CREATE TABLE IF NOT EXISTS org_access_requests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id       TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'pending',
  created_at   INTEGER NOT NULL,
  resolved_at  INTEGER,
  resolved_by  TEXT REFERENCES users(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS org_requests_one_pending_per_user
  ON org_access_requests(user_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS org_requests_status ON org_access_requests(status);

-- A reader device, keyed by the IMEI the logs API is addressed with.
--
-- The schedule columns mirror the settings API's daily report fields: the
-- device makes report_count_per_day reports a day, the first
-- report_start_minute minutes past local midnight and each one
-- report_interval_minutes after the last. poll_offset_minutes is how long
-- after a report we wait before reading the log it produced.
--
-- The defaults are the fleet's current setting (19 hourly reports from 04:10,
-- read 10 minutes later), so a device polls sensibly from the moment it is
-- registered, before its real settings have been read.
CREATE TABLE IF NOT EXISTS devices (
  imei                    TEXT PRIMARY KEY,
  org_id                  TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  label                   TEXT NOT NULL DEFAULT '',
  active                  INTEGER NOT NULL DEFAULT 1,
  report_start_minute     INTEGER NOT NULL DEFAULT 250,
  report_interval_minutes INTEGER NOT NULL DEFAULT 60,
  report_count_per_day    INTEGER NOT NULL DEFAULT 19,
  poll_offset_minutes     INTEGER NOT NULL DEFAULT 10,
  last_ingest_at          INTEGER,
  last_ingest_status      TEXT,
  -- The mesh radio id this reader identifies itself as inside a tag's own
  -- RssiSrc column — set by hand, since nothing in the logs or events API
  -- names it. Lets the link-view map draw a tag's line all the way back to
  -- the reader itself when a tag reached it directly, not through another tag.
  radio_id                TEXT,
  -- The reader's own position — not reported in the discovery logs at all,
  -- so it's read separately off the events API and cached here.
  gps_lat                 REAL,
  gps_lon                 REAL,
  gps_updated_at          INTEGER,
  created_at              INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS devices_org ON devices(org_id);

-- The per-organisation tag whitelist. A tag only becomes visible to an
-- organisation once it is listed here, even though its readings arrive
-- automatically through whichever of that organisation's devices heard it.
CREATE TABLE IF NOT EXISTS org_tags (
  org_id      TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  tag_id      TEXT NOT NULL,
  label       TEXT,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (org_id, tag_id)
);

-- Geofence boundaries, read off a reader's own events feed (never the
-- discovery logs) and cached per-organisation. region_id is the Farmranger
-- platform's own id, not one of ours — kept as the natural key alongside
-- org_id so re-ingesting the same region is a plain replace.
CREATE TABLE IF NOT EXISTS geofences (
  org_id       TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  region_id    TEXT NOT NULL,
  name         TEXT NOT NULL,
  color        TEXT,
  -- [[lat, lon], ...] — a JSON-encoded polygon, since SQLite has nowhere else to put one.
  coordinates  TEXT NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (org_id, region_id)
);

-- One row per (discovery round, reading device, tag). The primary key is what
-- makes ingest idempotent: every poll re-reads an overlapping window, and a
-- row that was already written is simply replaced with the same values.
CREATE TABLE IF NOT EXISTS readings (
  bracket_at      INTEGER NOT NULL,
  device_imei     TEXT NOT NULL REFERENCES devices(imei) ON DELETE CASCADE,
  tag_id          TEXT NOT NULL,
  battery_mv      INTEGER,
  rssi            INTEGER,
  hops            INTEGER,
  wave_count      INTEGER,
  movement_state  INTEGER,
  lat             REAL,
  lon             REAL,
  has_gps         INTEGER NOT NULL DEFAULT 0,
  fw_patch        INTEGER,
  gps_age_s       INTEGER,
  link_id         TEXT,
  PRIMARY KEY (bracket_at, device_imei, tag_id)
);

CREATE INDEX IF NOT EXISTS readings_tag_time ON readings(tag_id, bracket_at);
CREATE INDEX IF NOT EXISTS readings_device_time ON readings(device_imei, bracket_at);
CREATE INDEX IF NOT EXISTS readings_gps ON readings(has_gps, bracket_at);

-- Per-device health for one discovery round: how many tags it heard, how long
-- it took, its own supply voltage. Kept separate from readings because it
-- describes the reader, not any tag.
CREATE TABLE IF NOT EXISTS rounds (
  bracket_at        INTEGER NOT NULL,
  device_imei       TEXT NOT NULL REFERENCES devices(imei) ON DELETE CASCADE,
  tag_count         INTEGER NOT NULL,
  duration_seconds  INTEGER,
  unit_battery_mv   INTEGER,
  reader_fw         TEXT,
  timed_out         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bracket_at, device_imei)
);

CREATE TABLE IF NOT EXISTS ingest_runs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  device_imei      TEXT NOT NULL,
  started_at       INTEGER NOT NULL,
  finished_at      INTEGER,
  status           TEXT NOT NULL,
  blocks_parsed    INTEGER NOT NULL DEFAULT 0,
  readings_written INTEGER NOT NULL DEFAULT 0,
  error            TEXT
);

CREATE INDEX IF NOT EXISTS ingest_runs_device ON ingest_runs(device_imei, started_at DESC);

-- Single-row-per-key store for anything site-wide an admin can change.
CREATE TABLE IF NOT EXISTS app_settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

-- One row per user: their own map toggles (which tags are switched off, which
-- marker colour legend is active), so a preference set on one device is still
-- there on the next login rather than resetting every session.
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id  TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  prefs    TEXT NOT NULL
);

-- Access tokens for the Telegram bot process. Each token grants a single
-- Telegram worker bot read-only access to exactly one organisation, at a
-- fixed level (dev = full technical view, client = reduced). The bot presents
-- the raw token as a bearer credential; only its hash is stored here, so a
-- leak of this table can't be replayed. This is the *only* coupling between
-- the two projects: the web app populates every table above from the logs,
-- the bot reads through these tokens and never touches a log itself.
CREATE TABLE IF NOT EXISTS bot_tokens (
  id            TEXT PRIMARY KEY,
  token_hash    TEXT NOT NULL UNIQUE,
  org_id        TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  level         TEXT NOT NULL DEFAULT 'client',
  label         TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER
);

CREATE INDEX IF NOT EXISTS bot_tokens_org ON bot_tokens(org_id);
`;

export interface UserRow {
  id: string;
  username: string;
  passwordHash: string;
  role: UserRole;
  createdAt: number;
}

export interface SessionRow {
  id: string;
  userId: string;
  expiresAt: number;
}

/** A parsed reading, flattened to exactly what one `readings` row holds. */
export interface ReadingInput {
  bracketAt: number;
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
  fwPatch: number | null;
  gpsAgeSeconds: number | null;
  linkId: string | null;
}

export interface RoundInput {
  bracketAt: number;
  deviceImei: string;
  tagCount: number;
  durationSeconds: number | null;
  unitBatteryMv: number | null;
  readerFw: string | null;
  timedOut: boolean;
}

export interface ReadingWindow {
  orgId: string;
  from: number;
  to: number;
}

/** A raw `readings` row, snake_case as SQLite returns it — what the bot API ships. */
export interface BotReadingRow {
  bracket_at: number;
  device_imei: string;
  tag_id: string;
  battery_mv: number | null;
  rssi: number | null;
  hops: number | null;
  wave_count: number | null;
  movement_state: number | null;
  lat: number | null;
  lon: number | null;
  has_gps: number;
  fw_patch: number | null;
  gps_age_s: number | null;
  link_id: string | null;
}

/** A raw `rounds` row, snake_case as SQLite returns it. */
export interface BotRoundRow {
  bracket_at: number;
  device_imei: string;
  tag_count: number;
  duration_seconds: number | null;
  unit_battery_mv: number | null;
  reader_fw: string | null;
  timed_out: number;
}

/**
 * Make sure the site's one hard-coded admin is actually an admin, every boot.
 *
 * There is no invite flow or first-run wizard for the very first admin — it has
 * to come from somewhere — so this is that somewhere: idempotent, and it only
 * ever grants, never revokes, so demoting this account later (from the admin
 * panel, once there is a second admin to do the demoting) sticks instead of
 * being silently undone on the next restart.
 */
function bootstrapFoundingAdmin(db: DatabaseSyncType, username: string): void {
  const user = db
    .prepare('SELECT id, role FROM users WHERE username = ? COLLATE NOCASE')
    .get(username) as { id: string; role: string } | undefined;
  if (!user || user.role === 'admin') return;
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
}

/**
 * `client` replaced the original role name `user` (now that `dev` exists
 * alongside it as a second non-admin label) — a one-line data fix for any
 * database created before the rename, since the schema's own `DEFAULT` only
 * affects rows inserted from here on.
 */
function migrateLegacyUserRole(db: DatabaseSyncType): void {
  db.exec("UPDATE users SET role = 'client' WHERE role = 'user'");
}

/**
 * One-time backfill from the old single `users.org_id` into `user_orgs`, for
 * a database that predates multi-org membership. `INSERT OR IGNORE` makes
 * this a no-op on every later boot once the row already exists.
 */
function migrateUserOrgs(db: DatabaseSyncType): void {
  db.exec(`
    INSERT OR IGNORE INTO user_orgs (user_id, org_id)
    SELECT id, org_id FROM users WHERE org_id IS NOT NULL
  `);
}

/**
 * Adds `readings.link_id` to a database created before newer firmware started
 * reporting it — `CREATE TABLE IF NOT EXISTS` above only shapes a brand-new
 * table, so an existing one needs its own `ALTER TABLE`, guarded by checking
 * `PRAGMA table_info` first since SQLite has no `ADD COLUMN IF NOT EXISTS`.
 */
function migrateReadingsLinkId(db: DatabaseSyncType): void {
  const columns = db.prepare('PRAGMA table_info(readings)').all() as Array<{ name: string }>;
  if (columns.some((c) => c.name === 'link_id')) return;
  db.exec('ALTER TABLE readings ADD COLUMN link_id TEXT');
}

/** Same idea as `migrateReadingsLinkId`, for the reader's own radio id and cached position. */
function migrateDevicesRadioAndGps(db: DatabaseSyncType): void {
  const columns = db.prepare('PRAGMA table_info(devices)').all() as Array<{ name: string }>;
  const names = new Set(columns.map((c) => c.name));
  if (!names.has('radio_id')) db.exec('ALTER TABLE devices ADD COLUMN radio_id TEXT');
  if (!names.has('gps_lat')) db.exec('ALTER TABLE devices ADD COLUMN gps_lat REAL');
  if (!names.has('gps_lon')) db.exec('ALTER TABLE devices ADD COLUMN gps_lon REAL');
  if (!names.has('gps_updated_at')) db.exec('ALTER TABLE devices ADD COLUMN gps_updated_at INTEGER');
}

function toBool(value: unknown): boolean {
  return Number(value) === 1;
}

/**
 * `AND <alias>.device_imei NOT IN (...)` built from named placeholders, for
 * queries that optionally drop a subset of an org's devices — one toggled
 * off in the UI. Excluding (rather than enumerating the kept ones) means
 * "every device switched off" naturally excludes everything, with no need
 * for the caller to know the full device list first. Empty/undefined means
 * no filter at all (every device kept).
 */
function excludeDeviceFilterClause(
  excludeDeviceImeis: string[] | undefined,
  alias: string,
): { sql: string; params: Record<string, string> } {
  if (!excludeDeviceImeis || excludeDeviceImeis.length === 0) return { sql: '', params: {} };
  const params: Record<string, string> = {};
  const placeholders = excludeDeviceImeis.map((imei, i) => {
    const key = `excludeImei${i}`;
    params[key] = imei;
    return `:${key}`;
  });
  return { sql: ` AND ${alias}.device_imei NOT IN (${placeholders.join(', ')})`, params };
}

export class Store {
  private readonly db: DatabaseSyncType;

  constructor(dbPath: string, foundingAdminUsername: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    // WAL lets reads continue during a write, which matters because an ingest
    // run writes thousands of rows while people are panning the map.
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
    migrateLegacyUserRole(this.db);
    migrateUserOrgs(this.db);
    migrateReadingsLinkId(this.db);
    migrateDevicesRadioAndGps(this.db);
    bootstrapFoundingAdmin(this.db, foundingAdminUsername);
  }

  close(): void {
    this.db.close();
  }

  // --- Organisations -------------------------------------------------------

  createOrg(id: string, name: string): void {
    this.db.prepare('INSERT INTO organisations (id, name, created_at) VALUES (?, ?, ?)').run(id, name, Date.now());
  }

  renameOrg(id: string, name: string): void {
    this.db.prepare('UPDATE organisations SET name = ? WHERE id = ?').run(name, id);
  }

  /** Cascades to that organisation's devices, their readings, and its tag whitelist. */
  deleteOrg(id: string): void {
    this.db.prepare('DELETE FROM organisations WHERE id = ?').run(id);
  }

  getOrg(id: string): { id: string; name: string } | null {
    const row = this.db.prepare('SELECT id, name FROM organisations WHERE id = ?').get(id) as
      | { id: string; name: string }
      | undefined;
    return row ?? null;
  }

  getOrgByName(name: string): { id: string; name: string } | null {
    const row = this.db.prepare('SELECT id, name FROM organisations WHERE name = ? COLLATE NOCASE').get(name) as
      | { id: string; name: string }
      | undefined;
    return row ?? null;
  }

  listOrgs(): OrganisationRow[] {
    const rows = this.db
      .prepare(
        `SELECT o.id, o.name, o.created_at,
                (SELECT COUNT(*) FROM user_orgs uo WHERE uo.org_id = o.id) AS user_count,
                (SELECT COUNT(*) FROM devices d WHERE d.org_id = o.id)  AS device_count,
                (SELECT COUNT(*) FROM org_tags t WHERE t.org_id = o.id) AS tag_count
         FROM organisations o
         ORDER BY o.name COLLATE NOCASE ASC`,
      )
      .all() as Array<{
      id: string;
      name: string;
      created_at: number;
      user_count: number;
      device_count: number;
      tag_count: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      createdAt: r.created_at,
      userCount: r.user_count,
      deviceCount: r.device_count,
      tagCount: r.tag_count,
    }));
  }

  // --- Users ---------------------------------------------------------------

  /** New accounts always start at 'client' with no organisation — an admin places them. */
  createUser(id: string, username: string, passwordHash: string): void {
    this.db
      .prepare("INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, 'client', ?)")
      .run(id, username, passwordHash, Date.now());
  }

  private static toUserRow(row: {
    id: string;
    username: string;
    password_hash: string;
    role: string;
    created_at: number;
  }): UserRow {
    return {
      id: row.id,
      username: row.username,
      passwordHash: row.password_hash,
      role: row.role as UserRole,
      createdAt: row.created_at,
    };
  }

  private static readonly USER_COLUMNS = 'id, username, password_hash, role, created_at';

  getUserByUsername(username: string): UserRow | null {
    const row = this.db
      .prepare(`SELECT ${Store.USER_COLUMNS} FROM users WHERE username = ? COLLATE NOCASE`)
      .get(username) as Parameters<typeof Store.toUserRow>[0] | undefined;
    return row ? Store.toUserRow(row) : null;
  }

  getUserById(id: string): UserRow | null {
    const row = this.db.prepare(`SELECT ${Store.USER_COLUMNS} FROM users WHERE id = ?`).get(id) as
      | Parameters<typeof Store.toUserRow>[0]
      | undefined;
    return row ? Store.toUserRow(row) : null;
  }

  /** For the admin panel: every account, each with the full list of organisations it belongs to. */
  listUsers(): Array<{ id: string; username: string; role: UserRole; orgs: Array<{ id: string; name: string }>; createdAt: number }> {
    const users = this.db.prepare('SELECT id, username, role, created_at FROM users ORDER BY created_at ASC').all() as Array<{
      id: string;
      username: string;
      role: string;
      created_at: number;
    }>;
    const memberships = this.db
      .prepare(
        `SELECT uo.user_id, o.id AS org_id, o.name AS org_name
         FROM user_orgs uo JOIN organisations o ON o.id = uo.org_id
         ORDER BY o.name COLLATE NOCASE ASC`,
      )
      .all() as Array<{ user_id: string; org_id: string; org_name: string }>;

    const orgsByUser = new Map<string, Array<{ id: string; name: string }>>();
    for (const m of memberships) {
      const list = orgsByUser.get(m.user_id);
      const entry = { id: m.org_id, name: m.org_name };
      if (list) list.push(entry);
      else orgsByUser.set(m.user_id, [entry]);
    }

    return users.map((u) => ({
      id: u.id,
      username: u.username,
      role: u.role as UserRole,
      orgs: orgsByUser.get(u.id) ?? [],
      createdAt: u.created_at,
    }));
  }

  setUserRole(userId: string, role: UserRole): void {
    this.db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, userId);
  }

  setUserPassword(userId: string, passwordHash: string): void {
    this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, userId);
  }

  /** Every organisation this user belongs to — irrelevant for an admin, who sees all of them regardless. */
  listOrgsForUser(userId: string): Array<{ id: string; name: string }> {
    return this.db
      .prepare(
        `SELECT o.id, o.name FROM user_orgs uo
         JOIN organisations o ON o.id = uo.org_id
         WHERE uo.user_id = ? ORDER BY o.name COLLATE NOCASE ASC`,
      )
      .all(userId) as Array<{ id: string; name: string }>;
  }

  userHasOrg(userId: string, orgId: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM user_orgs WHERE user_id = ? AND org_id = ?').get(userId, orgId);
    return row !== undefined;
  }

  addUserOrg(userId: string, orgId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO user_orgs (user_id, org_id) VALUES (?, ?)').run(userId, orgId);
  }

  removeUserOrg(userId: string, orgId: string): void {
    this.db.prepare('DELETE FROM user_orgs WHERE user_id = ? AND org_id = ?').run(userId, orgId);
  }

  /** Replaces the user's whole set of organisation memberships in one transaction. */
  setUserOrgs(userId: string, orgIds: string[]): void {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM user_orgs WHERE user_id = ?').run(userId);
      const stmt = this.db.prepare('INSERT INTO user_orgs (user_id, org_id) VALUES (?, ?)');
      for (const orgId of orgIds) stmt.run(userId, orgId);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  deleteUser(userId: string): void {
    this.db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  }

  countAdmins(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get() as { n: number };
    return row.n;
  }

  /** Bare id/name list — what a user with no organisation yet picks a request from. */
  listOrgNames(): Array<{ id: string; name: string }> {
    return this.db.prepare('SELECT id, name FROM organisations ORDER BY name COLLATE NOCASE ASC').all() as Array<{
      id: string;
      name: string;
    }>;
  }

  // --- Organisation access requests -----------------------------------------

  /** Throws (a UNIQUE-constraint error) if this user already has a pending request. */
  createOrgRequest(userId: string, orgId: string): void {
    this.db
      .prepare("INSERT INTO org_access_requests (user_id, org_id, status, created_at) VALUES (?, ?, 'pending', ?)")
      .run(userId, orgId, Date.now());
  }

  private static toOrgRequestRow(row: {
    id: number;
    user_id: string;
    username: string;
    org_id: string;
    org_name: string | null;
    status: string;
    created_at: number;
  }): OrgAccessRequestRow {
    return {
      id: row.id,
      userId: row.user_id,
      username: row.username,
      orgId: row.org_id,
      orgName: row.org_name,
      status: row.status as OrgAccessRequestRow['status'],
      createdAt: row.created_at,
    };
  }

  private static readonly ORG_REQUEST_SELECT = `
    SELECT r.id, r.user_id, u.username, r.org_id, o.name AS org_name, r.status, r.created_at
    FROM org_access_requests r
    JOIN users u ON u.id = r.user_id
    LEFT JOIN organisations o ON o.id = r.org_id`;

  /** For the admin queue — every request still awaiting a decision. */
  listPendingOrgRequests(): OrgAccessRequestRow[] {
    const rows = this.db
      .prepare(`${Store.ORG_REQUEST_SELECT} WHERE r.status = 'pending' ORDER BY r.created_at ASC`)
      .all() as Array<Parameters<typeof Store.toOrgRequestRow>[0]>;
    return rows.map(Store.toOrgRequestRow);
  }

  /** For the requesting user's own screen — so a pending ask shows as pending, not as nothing. */
  getOrgRequestForUser(userId: string): OrgAccessRequestRow | null {
    const row = this.db
      .prepare(`${Store.ORG_REQUEST_SELECT} WHERE r.user_id = ? ORDER BY r.created_at DESC LIMIT 1`)
      .get(userId) as Parameters<typeof Store.toOrgRequestRow>[0] | undefined;
    return row ? Store.toOrgRequestRow(row) : null;
  }

  getOrgRequest(id: number): OrgAccessRequestRow | null {
    const row = this.db.prepare(`${Store.ORG_REQUEST_SELECT} WHERE r.id = ?`).get(id) as
      | Parameters<typeof Store.toOrgRequestRow>[0]
      | undefined;
    return row ? Store.toOrgRequestRow(row) : null;
  }

  /** Approving also places the user in the org, in one transaction — the two must never disagree. */
  approveOrgRequest(id: number, resolvedBy: string): void {
    const request = this.db.prepare('SELECT user_id, org_id FROM org_access_requests WHERE id = ?').get(id) as
      | { user_id: string; org_id: string }
      | undefined;
    if (!request) throw new Error(`No org request with id ${id}`);

    this.db.exec('BEGIN');
    try {
      this.db
        .prepare("UPDATE org_access_requests SET status = 'approved', resolved_at = ?, resolved_by = ? WHERE id = ?")
        .run(Date.now(), resolvedBy, id);
      // Adds to the user's memberships — approving one request never removes
      // another organisation they already belong to.
      this.db.prepare('INSERT OR IGNORE INTO user_orgs (user_id, org_id) VALUES (?, ?)').run(request.user_id, request.org_id);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  rejectOrgRequest(id: number, resolvedBy: string): void {
    this.db
      .prepare("UPDATE org_access_requests SET status = 'rejected', resolved_at = ?, resolved_by = ? WHERE id = ?")
      .run(Date.now(), resolvedBy, id);
  }

  // --- Sessions ------------------------------------------------------------

  createSession(id: string, userId: string, expiresAt: number): void {
    this.db
      .prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(id, userId, Date.now(), expiresAt);
  }

  getSession(id: string): SessionRow | null {
    const row = this.db.prepare('SELECT id, user_id, expires_at FROM sessions WHERE id = ?').get(id) as
      | { id: string; user_id: string; expires_at: number }
      | undefined;
    return row ? { id: row.id, userId: row.user_id, expiresAt: row.expires_at } : null;
  }

  deleteSession(id: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  // --- Devices -------------------------------------------------------------

  createDevice(imei: string, orgId: string, label: string, radioId: string | null = null): void {
    this.db
      .prepare('INSERT INTO devices (imei, org_id, label, radio_id, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(imei, orgId, label, radioId, Date.now());
  }

  private static toDeviceRow(row: {
    imei: string;
    org_id: string;
    org_name: string | null;
    label: string;
    active: number;
    report_start_minute: number;
    report_interval_minutes: number;
    report_count_per_day: number;
    poll_offset_minutes: number;
    last_ingest_at: number | null;
    last_ingest_status: string | null;
    radio_id: string | null;
    gps_lat: number | null;
    gps_lon: number | null;
    gps_updated_at: number | null;
    reader_fw: string | null;
    created_at: number;
  }): DeviceRow {
    return {
      imei: row.imei,
      orgId: row.org_id,
      orgName: row.org_name,
      label: row.label,
      active: toBool(row.active),
      reportStartMinute: row.report_start_minute,
      reportIntervalMinutes: row.report_interval_minutes,
      reportCountPerDay: row.report_count_per_day,
      pollOffsetMinutes: row.poll_offset_minutes,
      lastIngestAt: row.last_ingest_at,
      lastIngestStatus: row.last_ingest_status,
      radioId: row.radio_id,
      lat: row.gps_lat,
      lon: row.gps_lon,
      gpsUpdatedAt: row.gps_updated_at,
      readerFw: row.reader_fw,
      createdAt: row.created_at,
    };
  }

  private static readonly DEVICE_SELECT = `
    SELECT d.imei, d.org_id, o.name AS org_name, d.label, d.active,
           d.report_start_minute, d.report_interval_minutes, d.report_count_per_day,
           d.poll_offset_minutes, d.last_ingest_at, d.last_ingest_status,
           d.radio_id, d.gps_lat, d.gps_lon, d.gps_updated_at,
           (SELECT reader_fw FROM rounds WHERE device_imei = d.imei AND reader_fw IS NOT NULL
             ORDER BY bracket_at DESC LIMIT 1) AS reader_fw,
           d.created_at
    FROM devices d LEFT JOIN organisations o ON o.id = d.org_id`;

  listDevices(orgId?: string): DeviceRow[] {
    const sql = orgId
      ? `${Store.DEVICE_SELECT} WHERE d.org_id = ? ORDER BY d.created_at ASC`
      : `${Store.DEVICE_SELECT} ORDER BY o.name COLLATE NOCASE ASC, d.created_at ASC`;
    const stmt = this.db.prepare(sql);
    const rows = (orgId ? stmt.all(orgId) : stmt.all()) as Array<Parameters<typeof Store.toDeviceRow>[0]>;
    return rows.map(Store.toDeviceRow);
  }

  getDevice(imei: string): DeviceRow | null {
    const row = this.db.prepare(`${Store.DEVICE_SELECT} WHERE d.imei = ?`).get(imei) as
      | Parameters<typeof Store.toDeviceRow>[0]
      | undefined;
    return row ? Store.toDeviceRow(row) : null;
  }

  updateDevice(
    imei: string,
    patch: Partial<
      Pick<
        DeviceRow,
        | 'orgId'
        | 'label'
        | 'active'
        | 'reportStartMinute'
        | 'reportIntervalMinutes'
        | 'reportCountPerDay'
        | 'pollOffsetMinutes'
        | 'radioId'
      >
    >,
  ): void {
    const columns: Record<string, string> = {
      orgId: 'org_id',
      label: 'label',
      active: 'active',
      reportStartMinute: 'report_start_minute',
      reportIntervalMinutes: 'report_interval_minutes',
      reportCountPerDay: 'report_count_per_day',
      pollOffsetMinutes: 'poll_offset_minutes',
      radioId: 'radio_id',
    };
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    for (const [key, column] of Object.entries(columns)) {
      const value = patch[key as keyof typeof patch];
      if (value === undefined) continue;
      sets.push(`${column} = ?`);
      values.push(typeof value === 'boolean' ? (value ? 1 : 0) : value);
    }
    if (sets.length === 0) return;
    values.push(imei);
    this.db.prepare(`UPDATE devices SET ${sets.join(', ')} WHERE imei = ?`).run(...values);
  }

  deleteDevice(imei: string): void {
    this.db.prepare('DELETE FROM devices WHERE imei = ?').run(imei);
  }

  markDeviceIngest(imei: string, at: number, status: string): void {
    this.db.prepare('UPDATE devices SET last_ingest_at = ?, last_ingest_status = ? WHERE imei = ?').run(at, status, imei);
  }

  /** Caches the reader's own position, read separately off the events API — the discovery logs never carry it. */
  setDevicePosition(imei: string, lat: number, lon: number, updatedAt: number): void {
    this.db
      .prepare('UPDATE devices SET gps_lat = ?, gps_lon = ?, gps_updated_at = ? WHERE imei = ?')
      .run(lat, lon, updatedAt, imei);
  }

  // --- Tag whitelist -------------------------------------------------------

  /** Adds tag IDs to an organisation's whitelist, ignoring ones already there. */
  addOrgTags(orgId: string, tagIds: string[]): number {
    const stmt = this.db.prepare(
      'INSERT INTO org_tags (org_id, tag_id, label, created_at) VALUES (?, ?, NULL, ?) ON CONFLICT DO NOTHING',
    );
    const now = Date.now();
    let added = 0;
    this.db.exec('BEGIN');
    try {
      for (const tagId of tagIds) {
        added += Number(stmt.run(orgId, tagId, now).changes ?? 0);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return added;
  }

  setOrgTagLabel(orgId: string, tagId: string, label: string | null): void {
    this.db.prepare('UPDATE org_tags SET label = ? WHERE org_id = ? AND tag_id = ?').run(label, orgId, tagId);
  }

  removeOrgTag(orgId: string, tagId: string): void {
    this.db.prepare('DELETE FROM org_tags WHERE org_id = ? AND tag_id = ?').run(orgId, tagId);
  }

  /** The whitelist plus, for each entry, when that tag was last heard by any of the org's devices. */
  listOrgTags(orgId: string): OrgTagRow[] {
    const rows = this.db
      .prepare(
        `SELECT t.org_id, t.tag_id, t.label, t.created_at,
                (SELECT MAX(r.bracket_at) FROM readings r
                   JOIN devices d ON d.imei = r.device_imei
                  WHERE r.tag_id = t.tag_id AND d.org_id = t.org_id) AS last_seen_at
         FROM org_tags t WHERE t.org_id = ?
         ORDER BY t.tag_id ASC`,
      )
      .all(orgId) as Array<{
      org_id: string;
      tag_id: string;
      label: string | null;
      created_at: number;
      last_seen_at: number | null;
    }>;
    return rows.map((r) => ({
      orgId: r.org_id,
      tagId: r.tag_id,
      label: r.label,
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
    }));
  }

  // --- Geofences -------------------------------------------------------------

  /** Replaces (or adds) each region by its own id — same idempotent-on-reingest shape as `writeReadings`. */
  upsertGeofences(orgId: string, regions: GeofenceRegion[]): void {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO geofences (org_id, region_id, name, color, coordinates, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const now = Date.now();
    this.db.exec('BEGIN');
    try {
      for (const r of regions) {
        stmt.run(orgId, r.regionId, r.name, r.color, JSON.stringify(r.coordinates), now);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  listGeofences(orgId: string): GeofenceRegion[] {
    const rows = this.db
      .prepare('SELECT region_id, name, color, coordinates FROM geofences WHERE org_id = ? ORDER BY name COLLATE NOCASE ASC')
      .all(orgId) as Array<{ region_id: string; name: string; color: string | null; coordinates: string }>;
    return rows.map((r) => ({
      regionId: r.region_id,
      name: r.name,
      color: r.color,
      coordinates: JSON.parse(r.coordinates) as Array<[number, number]>,
    }));
  }

  /**
   * Tag IDs a device actually heard that nobody has whitelisted yet — the queue
   * an admin works from when a new batch of tags is deployed into the field.
   */
  listUnclaimedTags(sinceMs: number, orgId?: string): UnclaimedTagRow[] {
    const where = orgId ? 'AND d.org_id = ?' : '';
    const stmt = this.db.prepare(
      `SELECT r.tag_id, r.device_imei, d.org_id, o.name AS org_name,
              MAX(r.bracket_at) AS last_seen_at, COUNT(*) AS reading_count
       FROM readings r
       JOIN devices d ON d.imei = r.device_imei
       LEFT JOIN organisations o ON o.id = d.org_id
       WHERE r.bracket_at >= ? ${where}
         AND NOT EXISTS (SELECT 1 FROM org_tags t WHERE t.org_id = d.org_id AND t.tag_id = r.tag_id)
       GROUP BY r.tag_id, r.device_imei, d.org_id
       ORDER BY last_seen_at DESC`,
    );
    const rows = (orgId ? stmt.all(sinceMs, orgId) : stmt.all(sinceMs)) as Array<{
      tag_id: string;
      device_imei: string;
      org_id: string;
      org_name: string | null;
      last_seen_at: number;
      reading_count: number;
    }>;
    return rows.map((r) => ({
      tagId: r.tag_id,
      deviceImei: r.device_imei,
      orgId: r.org_id,
      orgName: r.org_name,
      lastSeenAt: r.last_seen_at,
      readingCount: r.reading_count,
    }));
  }

  // --- Readings ------------------------------------------------------------

  /**
   * Writes a poll's worth of readings and rounds in one transaction.
   *
   * `INSERT OR REPLACE` rather than `INSERT`: every poll deliberately re-reads
   * an overlapping window (a device can upload a bracket late), so the same row
   * arriving twice has to be a no-op rather than a constraint error.
   */
  writeReadings(readings: ReadingInput[], rounds: RoundInput[]): number {
    const readingStmt = this.db.prepare(
      `INSERT OR REPLACE INTO readings
       (bracket_at, device_imei, tag_id, battery_mv, rssi, hops, wave_count, movement_state, lat, lon, has_gps, fw_patch, gps_age_s, link_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const roundStmt = this.db.prepare(
      `INSERT OR REPLACE INTO rounds
       (bracket_at, device_imei, tag_count, duration_seconds, unit_battery_mv, reader_fw, timed_out)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    this.db.exec('BEGIN');
    try {
      for (const r of readings) {
        readingStmt.run(
          r.bracketAt,
          r.deviceImei,
          r.tagId,
          r.batteryMv,
          r.rssi,
          r.hops,
          r.waveCount,
          r.movementState,
          r.lat,
          r.lon,
          r.hasGps ? 1 : 0,
          r.fwPatch,
          r.gpsAgeSeconds,
          r.linkId,
        );
      }
      for (const r of rounds) {
        roundStmt.run(
          r.bracketAt,
          r.deviceImei,
          r.tagCount,
          r.durationSeconds,
          r.unitBatteryMv,
          r.readerFw,
          r.timedOut ? 1 : 0,
        );
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return readings.length;
  }

  /**
   * Every GPS-carrying reading for the organisation's whitelisted tags in the
   * window — raw points, one per fix, for a density heatmap. Unlike
   * `tagSnapshots` this deliberately does not collapse to "latest per tag": the
   * whole point of a heatmap is to show where a tag has actually been.
   */
  gpsPoints({ orgId, from, to }: ReadingWindow): GpsPoint[] {
    const rows = this.db
      .prepare(
        `SELECT r.lat, r.lon FROM readings r
           JOIN devices d ON d.imei = r.device_imei
          WHERE d.org_id = ? AND r.bracket_at BETWEEN ? AND ? AND r.has_gps = 1
            AND EXISTS (SELECT 1 FROM org_tags t WHERE t.org_id = d.org_id AND t.tag_id = r.tag_id)`,
      )
      .all(orgId, from, to) as Array<{ lat: number; lon: number }>;
    return rows;
  }

  /**
   * Every GPS-carrying reading for the given tags in the window, one row per
   * fix — the raw material for the movement map's replay. Unlike `gpsPoints`
   * this keeps `tagId` and `t` so positions can be grouped and stepped through
   * per tag instead of pooled into a single density cloud.
   */
  tagPositions({ orgId, from, to }: ReadingWindow, tagIds: string[]): TagPosition[] {
    if (tagIds.length === 0) return [];
    const placeholders = tagIds.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT r.tag_id, r.lat, r.lon, r.bracket_at AS t FROM readings r
           JOIN devices d ON d.imei = r.device_imei
          WHERE d.org_id = ? AND r.bracket_at BETWEEN ? AND ? AND r.has_gps = 1
            AND r.tag_id IN (${placeholders})
            AND EXISTS (SELECT 1 FROM org_tags t WHERE t.org_id = d.org_id AND t.tag_id = r.tag_id)
          ORDER BY r.tag_id ASC, r.bracket_at ASC`,
      )
      .all(orgId, from, to, ...tagIds) as Array<{ tag_id: string; lat: number; lon: number; t: number }>;
    return rows.map((r) => ({ tagId: r.tag_id, lat: r.lat, lon: r.lon, t: r.t }));
  }

  /**
   * Unique-tag count per discovery round — one row per bracket any of the
   * org's devices reported at, newest first. `count` is deduped across
   * devices (a tag two readers both heard in the same round counts once),
   * unlike `rounds.tag_count` which is per-device. The most recent row is
   * "the latest discovery"; the rest is what the count-history list scrolls
   * through.
   *
   * `durationSeconds` is the slowest device's own `rounds.duration_seconds`
   * for that bracket — how long after the bracket boundary (discovery is
   * assumed to start exactly on it) the round's last successful block
   * landed. Null when no round row exists for the bracket at all (older
   * data, or a device excluded by `excludeDeviceImeis`).
   */
  listDiscoveryCounts(orgId: string, limit = 200, excludeDeviceImeis?: string[]): DiscoveryCountPoint[] {
    const filterReadings = excludeDeviceFilterClause(excludeDeviceImeis, 'r');
    const filterRounds = excludeDeviceFilterClause(excludeDeviceImeis, 'ro');
    const rows = this.db
      .prepare(
        `SELECT r.bracket_at AS bracket_at, COUNT(DISTINCT r.tag_id) AS count,
                (SELECT MAX(ro.duration_seconds) FROM rounds ro
                   JOIN devices d2 ON d2.imei = ro.device_imei
                  WHERE d2.org_id = :org AND ro.bracket_at = r.bracket_at
                    ${filterRounds.sql}
                ) AS duration_seconds
           FROM readings r
           JOIN devices d ON d.imei = r.device_imei
          WHERE d.org_id = :org
            AND EXISTS (SELECT 1 FROM org_tags t WHERE t.org_id = d.org_id AND t.tag_id = r.tag_id)
            ${filterReadings.sql}
          GROUP BY r.bracket_at
          ORDER BY r.bracket_at DESC
          LIMIT :limit`,
      )
      .all({ org: orgId, limit, ...filterReadings.params, ...filterRounds.params }) as Array<{
      bracket_at: number;
      count: number;
      duration_seconds: number | null;
    }>;
    return rows.map((r) => ({ bracketAt: r.bracket_at, count: r.count, durationSeconds: r.duration_seconds }));
  }

  /** The most recent bracket this device has any reading for, or null if it has never reported. */
  latestBracketFor(imei: string): number | null {
    const row = this.db.prepare('SELECT MAX(bracket_at) AS t FROM readings WHERE device_imei = ?').get(imei) as
      | { t: number | null }
      | undefined;
    return row?.t ?? null;
  }

  /**
   * Latest known state of every whitelisted tag the organisation heard in the
   * window. Two separate "latest" passes, because the newest reading of a tag
   * frequently carries no fix while an older one does — the position is a
   * property of the tag, not of the scan that happened to mention it.
   */
  tagSnapshots({ orgId, from, to }: ReadingWindow, excludeDeviceImeis?: string[]): TagSnapshot[] {
    const filter = excludeDeviceFilterClause(excludeDeviceImeis, 'r');
    const rows = this.db
      .prepare(
        `WITH scoped AS (
           SELECT r.* FROM readings r
             JOIN devices d ON d.imei = r.device_imei
            WHERE d.org_id = :org AND r.bracket_at BETWEEN :from AND :to
              AND EXISTS (SELECT 1 FROM org_tags t WHERE t.org_id = :org AND t.tag_id = r.tag_id)
              ${filter.sql}
         ),
         latest AS (
           SELECT * FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY tag_id ORDER BY bracket_at DESC) rn FROM scoped)
            WHERE rn = 1
         ),
         latest_gps AS (
           SELECT * FROM (
             SELECT *, ROW_NUMBER() OVER (PARTITION BY tag_id ORDER BY bracket_at DESC) rn
               FROM scoped WHERE has_gps = 1
           ) WHERE rn = 1
         ),
         counts AS (SELECT tag_id, COUNT(DISTINCT bracket_at) AS n FROM scoped GROUP BY tag_id)
         SELECT l.tag_id, ot.label, l.bracket_at AS last_seen_at, l.battery_mv, l.rssi, l.hops,
                l.wave_count, l.movement_state, l.fw_patch, l.link_id, l.device_imei AS source_device_imei,
                g.lat, g.lon, g.bracket_at AS fix_at, g.gps_age_s, c.n AS reading_count
           FROM latest l
           LEFT JOIN latest_gps g ON g.tag_id = l.tag_id
           LEFT JOIN counts c ON c.tag_id = l.tag_id
           LEFT JOIN org_tags ot ON ot.org_id = :org AND ot.tag_id = l.tag_id
          ORDER BY l.bracket_at DESC, l.tag_id ASC`,
      )
      .all({ org: orgId, from, to, ...filter.params }) as Array<{
      tag_id: string;
      label: string | null;
      last_seen_at: number;
      battery_mv: number | null;
      rssi: number | null;
      hops: number | null;
      wave_count: number | null;
      movement_state: number | null;
      fw_patch: number | null;
      link_id: string | null;
      source_device_imei: string;
      lat: number | null;
      lon: number | null;
      fix_at: number | null;
      gps_age_s: number | null;
      reading_count: number;
    }>;

    return rows.map((r) => ({
      tagId: r.tag_id,
      label: r.label,
      lastSeenAt: r.last_seen_at,
      batteryMv: r.battery_mv,
      rssi: r.rssi,
      hops: r.hops,
      waveCount: r.wave_count,
      movementState: r.movement_state,
      fwVersionPatch: r.fw_patch,
      linkId: r.link_id,
      sourceDeviceImei: r.source_device_imei,
      lat: r.lat,
      lon: r.lon,
      fixAt: r.fix_at,
      gpsAgeSeconds: r.gps_age_s,
      readingCount: r.reading_count,
    }));
  }

  /**
   * Battery over time, one series per tag.
   *
   * A tag reporting every 15 minutes for a month is ~2,900 points; several tags
   * of that would be megabytes of JSON to draw a few hundred pixels wide. When
   * `bucketMinutes` is set, readings are averaged into fixed buckets in SQL, so
   * the response size follows the chart's width rather than the fleet's chattiness.
   */
  batterySeries(
    { orgId, from, to }: ReadingWindow,
    tagIds: string[],
    bucketMinutes: number,
  ): BatterySeries[] {
    if (tagIds.length === 0) return [];
    const placeholders = tagIds.map(() => '?').join(', ');
    const bucketMs = Math.max(1, Math.round(bucketMinutes)) * 60_000;

    const rows = this.db
      .prepare(
        `SELECT r.tag_id,
                (r.bracket_at / ${bucketMs}) * ${bucketMs} AS t,
                CAST(ROUND(AVG(r.battery_mv)) AS INTEGER)  AS mv
           FROM readings r
           JOIN devices d ON d.imei = r.device_imei
          WHERE d.org_id = ? AND r.bracket_at BETWEEN ? AND ?
            AND r.battery_mv IS NOT NULL
            AND r.tag_id IN (${placeholders})
            AND EXISTS (SELECT 1 FROM org_tags ot WHERE ot.org_id = d.org_id AND ot.tag_id = r.tag_id)
          GROUP BY r.tag_id, t
          ORDER BY r.tag_id ASC, t ASC`,
      )
      .all(orgId, from, to, ...tagIds) as Array<{ tag_id: string; t: number; mv: number }>;

    const labels = new Map(this.listOrgTags(orgId).map((t) => [t.tagId, t.label]));
    const byTag = new Map<string, BatterySeries>();
    for (const row of rows) {
      let series = byTag.get(row.tag_id);
      if (!series) {
        series = { tagId: row.tag_id, label: labels.get(row.tag_id) ?? null, points: [] };
        byTag.set(row.tag_id, series);
      }
      series.points.push({ t: row.t, mv: row.mv });
    }
    return [...byTag.values()];
  }

  // --- Ingest bookkeeping --------------------------------------------------

  startIngestRun(imei: string): number {
    const result = this.db
      .prepare("INSERT INTO ingest_runs (device_imei, started_at, status) VALUES (?, ?, 'running')")
      .run(imei, Date.now());
    return Number(result.lastInsertRowid);
  }

  finishIngestRun(
    id: number,
    status: 'ok' | 'error',
    counts: { blocksParsed: number; readingsWritten: number },
    error: string | null = null,
  ): void {
    this.db
      .prepare(
        `UPDATE ingest_runs SET finished_at = ?, status = ?, blocks_parsed = ?, readings_written = ?, error = ?
         WHERE id = ?`,
      )
      .run(Date.now(), status, counts.blocksParsed, counts.readingsWritten, error, id);
  }

  listIngestRuns(limit = 50, imei?: string): IngestRunRow[] {
    const stmt = this.db.prepare(
      `SELECT id, device_imei, started_at, finished_at, status, blocks_parsed, readings_written, error
       FROM ingest_runs ${imei ? 'WHERE device_imei = ?' : ''}
       ORDER BY started_at DESC LIMIT ?`,
    );
    const rows = (imei ? stmt.all(imei, limit) : stmt.all(limit)) as Array<{
      id: number;
      device_imei: string;
      started_at: number;
      finished_at: number | null;
      status: string;
      blocks_parsed: number;
      readings_written: number;
      error: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      deviceImei: r.device_imei,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      status: r.status,
      blocksParsed: r.blocks_parsed,
      readingsWritten: r.readings_written,
      error: r.error,
    }));
  }

  // --- App settings --------------------------------------------------------

  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  // --- User preferences ------------------------------------------------------

  /** Raw JSON, or null if this user has never saved a preference. */
  getUserPreferences(userId: string): string | null {
    const row = this.db.prepare('SELECT prefs FROM user_preferences WHERE user_id = ?').get(userId) as
      | { prefs: string }
      | undefined;
    return row?.prefs ?? null;
  }

  setUserPreferences(userId: string, prefsJson: string): void {
    this.db
      .prepare(
        'INSERT INTO user_preferences (user_id, prefs) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET prefs = excluded.prefs',
      )
      .run(userId, prefsJson);
  }

  // --- Bot access tokens ----------------------------------------------------

  createBotToken(id: string, tokenHash: string, orgId: string, level: string, label: string, createdAt: number): void {
    this.db
      .prepare('INSERT INTO bot_tokens (id, token_hash, org_id, level, label, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, tokenHash, orgId, level, label, createdAt);
  }

  /** Resolve a presented token (by its hash) to the org + level it grants, or null. */
  getBotTokenByHash(tokenHash: string): { id: string; orgId: string; level: string } | null {
    const row = this.db
      .prepare('SELECT id, org_id, level FROM bot_tokens WHERE token_hash = ?')
      .get(tokenHash) as { id: string; org_id: string; level: string } | undefined;
    return row ? { id: row.id, orgId: row.org_id, level: row.level } : null;
  }

  touchBotToken(id: string, at: number): void {
    this.db.prepare('UPDATE bot_tokens SET last_used_at = ? WHERE id = ?').run(at, id);
  }

  setBotTokenLevel(id: string, level: string): boolean {
    const info = this.db.prepare('UPDATE bot_tokens SET level = ? WHERE id = ?').run(level, id);
    return info.changes > 0;
  }

  /** All tokens, newest first — never the hash, only what an admin needs to see. */
  listBotTokens(): Array<{
    id: string;
    orgId: string;
    orgName: string | null;
    level: string;
    label: string;
    createdAt: number;
    lastUsedAt: number | null;
  }> {
    const rows = this.db
      .prepare(
        `SELECT t.id, t.org_id, o.name AS org_name, t.level, t.label, t.created_at, t.last_used_at
           FROM bot_tokens t LEFT JOIN organisations o ON o.id = t.org_id
          ORDER BY t.created_at DESC`,
      )
      .all() as Array<{
      id: string;
      org_id: string;
      org_name: string | null;
      level: string;
      label: string;
      created_at: number;
      last_used_at: number | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      orgId: r.org_id,
      orgName: r.org_name,
      level: r.level,
      label: r.label,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
    }));
  }

  deleteBotToken(id: string): boolean {
    const info = this.db.prepare('DELETE FROM bot_tokens WHERE id = ?').run(id);
    return info.changes > 0;
  }

  // --- Raw readings for the bot ---------------------------------------------

  /**
   * Every raw reading for the organisation's devices in the window — NOT
   * whitelist-filtered, deliberately: the dev bot's raw discovery tables must
   * show exactly what the readers reported, and the bot applies the whitelist
   * itself for its client-facing views. This is the workhorse the bot rebuilds
   * all of its "sessions" from; everything else it shows derives from these
   * rows plus `listRoundsWindow`.
   */
  listReadingsWindow(orgId: string, from: number, to: number): BotReadingRow[] {
    const rows = this.db
      .prepare(
        `SELECT r.bracket_at, r.device_imei, r.tag_id, r.battery_mv, r.rssi, r.hops, r.wave_count,
                r.movement_state, r.lat, r.lon, r.has_gps, r.fw_patch, r.gps_age_s, r.link_id
           FROM readings r
           JOIN devices d ON d.imei = r.device_imei
          WHERE d.org_id = ? AND r.bracket_at BETWEEN ? AND ?
          ORDER BY r.bracket_at ASC`,
      )
      .all(orgId, from, to) as unknown as BotReadingRow[];
    return rows;
  }

  /** Per-device round health in the window, for the org — supplies fw/duration/timeout. */
  listRoundsWindow(orgId: string, from: number, to: number): BotRoundRow[] {
    const rows = this.db
      .prepare(
        `SELECT ro.bracket_at, ro.device_imei, ro.tag_count, ro.duration_seconds,
                ro.unit_battery_mv, ro.reader_fw, ro.timed_out
           FROM rounds ro
           JOIN devices d ON d.imei = ro.device_imei
          WHERE d.org_id = ? AND ro.bracket_at BETWEEN ? AND ?
          ORDER BY ro.bracket_at ASC`,
      )
      .all(orgId, from, to) as unknown as BotRoundRow[];
    return rows;
  }

  // --- Housekeeping --------------------------------------------------------

  /** Drops expired sessions and ingest-run rows older than a fortnight. */
  prune(): void {
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
    this.db.prepare('DELETE FROM ingest_runs WHERE started_at < ?').run(Date.now() - 14 * 86_400_000);
  }
}
