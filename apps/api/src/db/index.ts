import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import type {
  BatterySeries,
  DeviceRow,
  IngestRunRow,
  OrgTagRow,
  OrganisationRow,
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

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user',
  org_id        TEXT REFERENCES organisations(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS users_org ON users(org_id);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

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
`;

export interface UserRow {
  id: string;
  username: string;
  passwordHash: string;
  role: UserRole;
  orgId: string | null;
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

function toBool(value: unknown): boolean {
  return Number(value) === 1;
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
                (SELECT COUNT(*) FROM users u WHERE u.org_id = o.id)    AS user_count,
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

  /** New accounts always start at 'user' with no organisation — an admin places them. */
  createUser(id: string, username: string, passwordHash: string): void {
    this.db
      .prepare("INSERT INTO users (id, username, password_hash, role, org_id, created_at) VALUES (?, ?, ?, 'user', NULL, ?)")
      .run(id, username, passwordHash, Date.now());
  }

  private static toUserRow(row: {
    id: string;
    username: string;
    password_hash: string;
    role: string;
    org_id: string | null;
    created_at: number;
  }): UserRow {
    return {
      id: row.id,
      username: row.username,
      passwordHash: row.password_hash,
      role: row.role as UserRole,
      orgId: row.org_id,
      createdAt: row.created_at,
    };
  }

  private static readonly USER_COLUMNS = 'id, username, password_hash, role, org_id, created_at';

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

  listUsers(): Array<{ id: string; username: string; role: UserRole; orgId: string | null; orgName: string | null; createdAt: number }> {
    const rows = this.db
      .prepare(
        `SELECT u.id, u.username, u.role, u.org_id, o.name AS org_name, u.created_at
         FROM users u LEFT JOIN organisations o ON o.id = u.org_id
         ORDER BY u.created_at ASC`,
      )
      .all() as Array<{
      id: string;
      username: string;
      role: string;
      org_id: string | null;
      org_name: string | null;
      created_at: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      username: r.username,
      role: r.role as UserRole,
      orgId: r.org_id,
      orgName: r.org_name,
      createdAt: r.created_at,
    }));
  }

  setUserRole(userId: string, role: UserRole): void {
    this.db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, userId);
  }

  setUserOrg(userId: string, orgId: string | null): void {
    this.db.prepare('UPDATE users SET org_id = ? WHERE id = ?').run(orgId, userId);
  }

  deleteUser(userId: string): void {
    this.db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  }

  countAdmins(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get() as { n: number };
    return row.n;
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

  createDevice(imei: string, orgId: string, label: string): void {
    this.db
      .prepare('INSERT INTO devices (imei, org_id, label, created_at) VALUES (?, ?, ?, ?)')
      .run(imei, orgId, label, Date.now());
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
      createdAt: row.created_at,
    };
  }

  private static readonly DEVICE_SELECT = `
    SELECT d.imei, d.org_id, o.name AS org_name, d.label, d.active,
           d.report_start_minute, d.report_interval_minutes, d.report_count_per_day,
           d.poll_offset_minutes, d.last_ingest_at, d.last_ingest_status, d.created_at
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
        'orgId' | 'label' | 'active' | 'reportStartMinute' | 'reportIntervalMinutes' | 'reportCountPerDay' | 'pollOffsetMinutes'
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
    };
    const sets: string[] = [];
    const values: Array<string | number> = [];
    for (const [key, column] of Object.entries(columns)) {
      const value = patch[key as keyof typeof patch];
      if (value === undefined) continue;
      sets.push(`${column} = ?`);
      values.push(typeof value === 'boolean' ? (value ? 1 : 0) : (value as string | number));
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
       (bracket_at, device_imei, tag_id, battery_mv, rssi, hops, wave_count, movement_state, lat, lon, has_gps, fw_patch, gps_age_s)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  tagSnapshots({ orgId, from, to }: ReadingWindow): TagSnapshot[] {
    const rows = this.db
      .prepare(
        `WITH scoped AS (
           SELECT r.* FROM readings r
             JOIN devices d ON d.imei = r.device_imei
            WHERE d.org_id = :org AND r.bracket_at BETWEEN :from AND :to
              AND EXISTS (SELECT 1 FROM org_tags t WHERE t.org_id = :org AND t.tag_id = r.tag_id)
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
                l.wave_count, l.movement_state, l.fw_patch, l.device_imei AS source_device_imei,
                g.lat, g.lon, g.bracket_at AS fix_at, g.gps_age_s, c.n AS reading_count
           FROM latest l
           LEFT JOIN latest_gps g ON g.tag_id = l.tag_id
           LEFT JOIN counts c ON c.tag_id = l.tag_id
           LEFT JOIN org_tags ot ON ot.org_id = :org AND ot.tag_id = l.tag_id
          ORDER BY l.bracket_at DESC, l.tag_id ASC`,
      )
      .all({ org: orgId, from, to }) as Array<{
      tag_id: string;
      label: string | null;
      last_seen_at: number;
      battery_mv: number | null;
      rssi: number | null;
      hops: number | null;
      wave_count: number | null;
      movement_state: number | null;
      fw_patch: number | null;
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

  // --- Housekeeping --------------------------------------------------------

  /** Drops expired sessions and ingest-run rows older than a fortnight. */
  prune(): void {
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
    this.db.prepare('DELETE FROM ingest_runs WHERE started_at < ?').run(Date.now() - 14 * 86_400_000);
  }
}
