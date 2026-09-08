import { resolve } from 'node:path';

const num = (value: string | undefined, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export interface Config {
  port: number;
  dataDir: string;
  dbPath: string;
  publicBaseUrl: string;
  /** Directory of built web assets to serve, or null in dev (Vite serves them). */
  webRoot: string | null;

  /** Farmranger logs API, ending in a slash — `<base><imei>/logs?From=…&To=…`. */
  logsApiBase: string;
  /**
   * Farmranger device-settings API, ending in a slash — it is called as
   * `<base><imei>/settings`. Unlike the logs endpoint this one needs a bearer
   * token; without one the scheduler leaves every device on its stored
   * schedule instead of failing.
   */
  settingsApiBase: string;
  settingsApiToken: string;

  /**
   * Shared secret the Telegram bot's manager uses to provision itself: list
   * organisations and mint/revoke per-bot access tokens, server-to-server
   * (no browser session). Blank disables the provisioning API entirely, so a
   * deployment not running the bot exposes nothing extra.
   */
  botProvisionToken: string;

  /**
   * How far back a brand-new device is backfilled on first ingest. The API is
   * queried a day at a time to keep any single response small.
   */
  backfillDays: number;
  /**
   * Overlap re-read on every poll. A device can upload a bracket late, and the
   * API's From filter matches each raw log line's own timestamp while sessions
   * are keyed by their rounded bracket — so a block logged at 23:58 belongs to
   * the 00:00 bracket yet falls outside a "since midnight" query. Reading a few
   * hours further back than strictly needed catches both cases; the readings
   * primary key makes the re-read a no-op.
   */
  pollLookbackHours: number;
  /** Discovery timestamps round to the nearest bracket of this many minutes. */
  bracketMinutes: number;
  /**
   * The account that is force-promoted to admin on every boot — and, if it
   * doesn't exist yet (a fresh database, e.g. a new Railway deploy), created
   * with this password. Once the account exists, its password is never
   * touched here again.
   */
  foundingAdminUsername: string;
  foundingAdminPassword: string;
}

export function loadConfig(): Config {
  const dataDir = resolve(process.env['DATA_DIR'] ?? './data');
  // Read API_PORT first, not the generic PORT: the browser-preview harness sets
  // PORT to whatever it is proxying to (the Vite dev server's port), and since
  // concurrently shares one environment across core/api/web, a bare PORT here
  // would silently steal that port from the API process instead of Vite.
  const port = num(process.env['API_PORT'] ?? process.env['PORT'], 8787);

  return {
    port,
    dataDir,
    dbPath: resolve(dataDir, 'tagexplore.db'),
    publicBaseUrl: (process.env['PUBLIC_BASE_URL'] ?? `http://localhost:${port}`).replace(/\/$/, ''),
    webRoot: process.env['WEB_ROOT'] ?? null,

    logsApiBase: (process.env['LOGS_API_BASE'] ?? 'https://api.services.farmrangersa.com/v2/unit/').replace(/\/?$/, '/'),
    settingsApiBase: (process.env['SETTINGS_API_BASE'] ?? 'https://api.farmrangersa.com/api/v2018-02-04/units/').replace(
      /\/?$/,
      '/',
    ),
    settingsApiToken: process.env['SETTINGS_API_TOKEN'] ?? '',

    botProvisionToken: process.env['BOT_PROVISION_TOKEN'] ?? '',

    backfillDays: num(process.env['BACKFILL_DAYS'], 7),
    pollLookbackHours: num(process.env['POLL_LOOKBACK_HOURS'], 4),
    bracketMinutes: num(process.env['BRACKET_MINUTES'], 15),
    foundingAdminUsername: process.env['FOUNDING_ADMIN_USERNAME'] ?? 'ruandj',
    foundingAdminPassword: process.env['FOUNDING_ADMIN_PASSWORD'] ?? 'Rdj@5046',
  };
}
