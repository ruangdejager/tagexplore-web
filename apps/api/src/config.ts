import { resolve } from 'node:path';

const num = (value: string | undefined, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const bool = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined || value === '') return fallback;
  return !/^(0|false|no|off)$/i.test(value.trim());
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
   * How often every active reader's own position (and the geofences that ride
   * the same events-API call) is re-read, regardless of how its readings
   * arrive. This used to be a side effect of a log scrape, which tied the
   * purple marker to the scrape schedule and meant a push-only device's marker
   * would never move again.
   */
  positionPollMinutes: number;
  /**
   * Per-reader debounce on the position read a pushed campaign triggers. A
   * unit posting several campaigns in a burst makes one events-API call, and
   * the debounce is shared with the periodic poll above so a push doesn't
   * reset that clock twice.
   */
  positionPollOnPushMinutes: number;
  /**
   * How long a reader on `ingest_mode = 'auto'` may go without pushing before
   * it falls back to log scraping. Three missed hourly campaigns by default —
   * comfortably longer than the fleet's own report interval, so ordinary
   * jitter never flaps it.
   */
  pushGraceMinutes: number;

  /** SSE keepalive. Also what the client times its "stream went quiet" check off. */
  liveHeartbeatSeconds: number;
  /** Runaway-tab guard: past this, `/api/events` answers 503 and the client polls instead. */
  liveMaxSubscribersPerOrg: number;

  /**
   * How close a reader's own GPS fix has to be to a discovery before it counts
   * as that discovery's position. Outside it, the reader is shown greyed
   * rather than presented as current — see `devices/position.ts`.
   */
  devicePositionWindowMinutes: number;
  /**
   * Whether a scraped round's window is widened by half a bracket. A scraped
   * round only knows the 15-minute bucket its blocks fell in, so its true time
   * is anywhere within ±bracketMinutes/2 of that — folding the uncertainty in
   * explicitly beats pretending the bracket is exact. A pushed round has a
   * real arrival time and never gets the slack.
   */
  devicePositionBracketSlack: boolean;

  /** Trailing window of readings the identity inference reasons over. */
  inferenceWindowDays: number;
  /** Per-device rate limit on running that inference. */
  inferenceIntervalMinutes: number;
  /** Discovery rounds of evidence before a radio id may be chosen. */
  radioIdMinRounds: number;
  /**
   * Share of the wave-one vote the winner needs. Note `num()` rejects values
   * ≤ 0, so a deliberate 0 falls back to this default rather than accepting
   * every candidate — which is the safe direction for a threshold.
   */
  radioIdMinShare: number;
  /** Discovery rounds of evidence before a carried tag may be chosen — about a day at 19 reports. */
  carriedTagMinRounds: number;
  /** Acceptance floor for the carried-tag score. Same `num()` note as `radioIdMinShare`. */
  carriedTagMinScore: number;
  /** How far clear of the runner-up the winner has to be. A near-tie abstains. */
  carriedTagMinMargin: number;

  /**
   * Logs every push-ingest POST with its IMEI, byte count and full raw body
   * hex. On by default for the first field round of the CBOR endpoint: the
   * same campaign also arrives by the log-scraping path, and diffing our
   * received bytes against the unit's own debug log (which prints the encoded
   * length and record count) is how a disagreement gets attributed. Set
   * TAG_DISCOVERY_DEBUG=0 once that stops being worth the log volume.
   */
  tagDiscoveryDebug: boolean;
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

    positionPollMinutes: num(process.env['POSITION_POLL_MINUTES'], 5),
    positionPollOnPushMinutes: num(process.env['POSITION_POLL_ON_PUSH_MINUTES'], 5),
    pushGraceMinutes: num(process.env['PUSH_GRACE_MINUTES'], 180),

    liveHeartbeatSeconds: num(process.env['LIVE_HEARTBEAT_SECONDS'], 25),
    liveMaxSubscribersPerOrg: num(process.env['LIVE_MAX_SUBSCRIBERS_PER_ORG'], 50),

    devicePositionWindowMinutes: num(process.env['DEVICE_POSITION_WINDOW_MINUTES'], 10),
    devicePositionBracketSlack: bool(process.env['DEVICE_POSITION_BRACKET_SLACK'], true),

    inferenceWindowDays: num(process.env['INFERENCE_WINDOW_DAYS'], 7),
    inferenceIntervalMinutes: num(process.env['INFERENCE_INTERVAL_MINUTES'], 30),
    radioIdMinRounds: num(process.env['RADIO_ID_MIN_ROUNDS'], 5),
    radioIdMinShare: num(process.env['RADIO_ID_MIN_SHARE'], 0.8),
    carriedTagMinRounds: num(process.env['CARRIED_TAG_MIN_ROUNDS'], 20),
    carriedTagMinScore: num(process.env['CARRIED_TAG_MIN_SCORE'], 0.8),
    carriedTagMinMargin: num(process.env['CARRIED_TAG_MIN_MARGIN'], 0.15),

    tagDiscoveryDebug: bool(process.env['TAG_DISCOVERY_DEBUG'], true),
    foundingAdminUsername: process.env['FOUNDING_ADMIN_USERNAME'] ?? 'ruandj',
    foundingAdminPassword: process.env['FOUNDING_ADMIN_PASSWORD'] ?? 'Rdj@5046',
  };
}
