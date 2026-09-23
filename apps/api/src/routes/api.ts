import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { parseTagIdList } from '@tagexplore/core';
import { currentUser } from '../auth/session.js';
import type { Config } from '../config.js';
import type { Store, UserRow } from '../db/index.js';
import { resolveDevicePosition } from '../devices/position.js';
import type { LiveBus, LiveEvent } from '../events/bus.js';
import { effectiveIngestMode } from '../ingest/scheduler.js';

export interface ApiDeps {
  store: Store;
  config: Config;
  bus: LiveBus;
}

/**
 * Identifies this process to a reconnecting client. A reconnect that finds a
 * different value reconnected across a restart or a deploy, and has to assume
 * it missed something — see `useLiveEvents`.
 */
const SERVER_STARTED_AT = Date.now();

const DEFAULT_WINDOW_HOURS = 72;
const MAX_WINDOW_DAYS = 365;
/**
 * Roughly one point per two pixels on a wide chart. Past this, more points buy
 * nothing visible and cost real bytes — so readings are averaged into buckets
 * whose width is derived from the requested range.
 */
const TARGET_CHART_POINTS = 400;

type Env = { Variables: { user: UserRow; orgId: string } };

interface Window {
  from: number;
  to: number;
}

/**
 * Resolves `from`/`to`/`hours` query parameters into an absolute window.
 * `hours` is the convenience form the map uses; explicit epoch milliseconds are
 * what the battery-trend range picker sends.
 */
function readWindow(query: Record<string, string | undefined>, nowMs: number): Window | { error: string } {
  const to = query['to'] ? Number(query['to']) : nowMs;
  if (!Number.isFinite(to)) return { error: '`to` must be epoch milliseconds.' };

  let from: number;
  if (query['from']) {
    from = Number(query['from']);
    if (!Number.isFinite(from)) return { error: '`from` must be epoch milliseconds.' };
  } else {
    const hours = Number(query['hours'] ?? DEFAULT_WINDOW_HOURS);
    if (!Number.isFinite(hours) || hours <= 0) return { error: '`hours` must be a positive number.' };
    from = to - hours * 3_600_000;
  }

  if (from >= to) return { error: '`from` must be before `to`.' };
  if (to - from > MAX_WINDOW_DAYS * 86_400_000) return { error: `Range is capped at ${MAX_WINDOW_DAYS} days.` };
  return { from, to };
}

/**
 * `excludeDevices=imei1,imei2` drops those devices' readings from a query — a
 * device switched off in the main list. Absent or empty means no filter at
 * all (every device kept).
 */
function parseExcludeDeviceImeis(query: Record<string, string | undefined>): string[] | undefined {
  const raw = query['excludeDevices'];
  if (!raw) return undefined;
  const ids = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.length ? ids : undefined;
}

export function bucketMinutesFor(from: number, to: number, floorMinutes: number): number {
  const rangeMinutes = (to - from) / 60_000;
  return Math.max(floorMinutes, Math.ceil(rangeMinutes / TARGET_CHART_POINTS));
}

export function createApi(deps: ApiDeps): Hono<Env> {
  const api = new Hono<Env>();

  /**
   * Everything below is organisation-scoped. A normal user may belong to
   * several organisations and picks one via `?orgId=`, but only from among
   * their own memberships; an admin may pass any organisation's id at all,
   * which is what makes "check what this client actually sees" possible
   * without a second login.
   */
  api.use('*', async (c, next) => {
    const user = currentUser(c, deps.store);
    if (!user) return c.json({ error: 'Log in first.' }, 401);

    const requested = c.req.query('orgId');
    const isAdmin = user.role === 'admin';
    let orgId: string | null;

    if (isAdmin) {
      if (requested && !deps.store.getOrg(requested)) return c.json({ error: 'No organisation with that id.' }, 404);
      orgId = requested ?? null;
    } else {
      const memberships = deps.store.listOrgsForUser(user.id);
      if (requested) {
        if (!memberships.some((o) => o.id === requested)) {
          return c.json({ error: 'You are not a member of that organisation.' }, 403);
        }
        orgId = requested;
      } else {
        // No explicit pick — default to the first organisation this account belongs to.
        orgId = memberships[0]?.id ?? null;
      }
    }

    if (!orgId) {
      return c.json({ error: 'Your account is not in an organisation yet — an admin needs to add you to one.' }, 403);
    }

    c.set('user', user);
    c.set('orgId', orgId);
    await next();
  });

  /** The organisation's whitelisted tags — the toggle list for the trend view. */
  api.get('/tags', (c) => c.json({ tags: deps.store.listOrgTags(c.get('orgId')) }));

  /**
   * Switches one tag off, or back on, for the whole organisation.
   *
   * Open to any member rather than admins only, on purpose: switching a tag
   * off records that it is known to be inactive, and the person who notices a
   * dead tag in the field is rarely the person with the admin password. It is
   * also trivially reversible and plainly attributed in the UI, which is what
   * makes that safe.
   */
  api.patch('/tags/:tagId', async (c) => {
    const orgId = c.get('orgId');
    const tagId = c.req.param('tagId').toUpperCase();
    if (!deps.store.listOrgTags(orgId).some((t) => t.tagId === tagId)) {
      return c.json({ error: 'That tag is not on this organisation’s list.' }, 404);
    }

    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof body['hidden'] !== 'boolean') return c.json({ error: '`hidden` must be true or false.' }, 400);

    deps.store.setOrgTagHidden(orgId, tagId, body['hidden']);
    // Everyone looking at this org has to see the new count, not just whoever
    // clicked — which is the entire reason this moved off a user preference.
    deps.bus.publish({ type: 'tags', orgId, imei: '', at: Date.now() });
    return c.json({ tags: deps.store.listOrgTags(orgId) });
  });

  /** Latest state of every whitelisted tag heard in the window: the map and the sidebar. */
  api.get('/snapshots', (c) => {
    const window = readWindow(c.req.query(), Date.now());
    if ('error' in window) return c.json({ error: window.error }, 400);

    const excludeDeviceImeis = parseExcludeDeviceImeis(c.req.query());
    return c.json({
      from: window.from,
      to: window.to,
      snapshots: deps.store.tagSnapshots({ orgId: c.get('orgId'), ...window }, excludeDeviceImeis),
      links: deps.store.linkReadings({ orgId: c.get('orgId'), ...window }, excludeDeviceImeis),
    });
  });

  /** Raw GPS fixes in the window, for the density heatmap — not collapsed to one-per-tag like `/snapshots`. */
  api.get('/positions', (c) => {
    const window = readWindow(c.req.query(), Date.now());
    if ('error' in window) return c.json({ error: window.error }, 400);

    return c.json({
      from: window.from,
      to: window.to,
      points: deps.store.gpsPoints({ orgId: c.get('orgId'), ...window }),
    });
  });

  /**
   * Per-tag GPS fixes in the window, for the movement map's replay. `tags`
   * works the same as `/battery`'s: only the toggled-on tags are sent, and
   * an empty selection falls back to the whole whitelist.
   */
  api.get('/tag-positions', (c) => {
    const orgId = c.get('orgId');
    const window = readWindow(c.req.query(), Date.now());
    if ('error' in window) return c.json({ error: window.error }, 400);

    const requested = c.req.query('tags');
    const { ids, invalid } = parseTagIdList(requested ?? '');
    if (requested && ids.length === 0) {
      return c.json({ error: invalid.length ? `Not tag IDs: ${invalid.join(', ')}` : 'No tag IDs given.' }, 400);
    }
    const tagIds = ids.length ? ids : deps.store.listOrgTags(orgId).map((t) => t.tagId);

    return c.json({
      from: window.from,
      to: window.to,
      points: deps.store.tagPositions({ orgId, ...window }, tagIds),
    });
  });

  /** Per-round unique-tag counts, newest first — the count panel's "latest" figure and its history list. */
  api.get('/discovery-counts', (c) => {
    const limit = Math.min(1000, Number(c.req.query('limit') ?? 200) || 200);
    return c.json({ counts: deps.store.listDiscoveryCounts(c.get('orgId'), limit, parseExcludeDeviceImeis(c.req.query())) });
  });

  /**
   * Everything stored behind one row of that count history: each reader's own
   * round, the CBOR receipt where the round was pushed rather than scraped, and
   * every individual reading uncollapsed.
   *
   * `dev` and `admin` only. It is a diagnostic view of how the data arrived —
   * raw column values, ingest path, byte counts — and it deliberately shows
   * readings for tags outside the organisation's whitelist, which a client has
   * no business seeing and no use for.
   */
  api.get('/discovery-detail', (c) => {
    const role = c.get('user').role;
    if (role !== 'admin' && role !== 'dev') return c.json({ error: 'Not available for your account.' }, 403);

    const at = Number(c.req.query('at'));
    if (!Number.isFinite(at)) return c.json({ error: '`at` must be epoch milliseconds.' }, 400);

    return c.json(deps.store.discoveryDetail(c.get('orgId'), at, parseExcludeDeviceImeis(c.req.query())));
  });

  /**
   * Battery over time. `tags` selects which series to return — the client sends
   * only the tags whose toggle is on, so switching one off costs nothing to draw
   * and nothing to transfer.
   */
  api.get('/battery', (c) => {
    const orgId = c.get('orgId');
    const window = readWindow(c.req.query(), Date.now());
    if ('error' in window) return c.json({ error: window.error }, 400);

    const requested = c.req.query('tags');
    const { ids, invalid } = parseTagIdList(requested ?? '');
    if (requested && ids.length === 0) {
      return c.json({ error: invalid.length ? `Not tag IDs: ${invalid.join(', ')}` : 'No tag IDs given.' }, 400);
    }
    // No selection means the whole whitelist, which is the useful default the
    // first time the view is opened.
    const tagIds = ids.length ? ids : deps.store.listOrgTags(orgId).map((t) => t.tagId);

    const bucketMinutes = bucketMinutesFor(window.from, window.to, deps.config.bracketMinutes);
    return c.json({
      from: window.from,
      to: window.to,
      bucketMinutes,
      series: deps.store.batterySeries({ orgId, ...window }, tagIds, bucketMinutes),
    });
  });

  /**
   * The organisation's readers, so the tag card can name the device that heard
   * a tag.
   *
   * Every row goes through `resolveDevicePosition`, with or without `at`: a
   * reader's cached fix has to be judged against a discovery before it can be
   * shown as that discovery's position, and "live" is just the reader's own
   * newest round rather than a different rule. `at` (epoch ms) picks a past
   * round instead — that round's own purple marker, not today's.
   */
  api.get('/devices', (c) => {
    const atRaw = c.req.query('at');
    let at: number | null = null;
    if (atRaw !== undefined) {
      at = Number(atRaw);
      if (!Number.isFinite(at)) return c.json({ error: '`at` must be epoch milliseconds.' }, 400);
    }

    const nowMs = Date.now();
    const pushGraceMs = deps.config.pushGraceMinutes * 60_000;
    const devices = deps.store
      .listDevices(c.get('orgId'))
      .map((d) => resolveDevicePosition(deps.store, deps.config, d, at))
      .map((d) => ({ ...d, effectiveIngestMode: effectiveIngestMode(d, d.lastPushAt, nowMs, pushGraceMs) }));

    // A non-admin has no business seeing ingest error strings; the label, IMEI
    // and whether it is active are enough to make sense of the map.
    if (c.get('user').role === 'admin') return c.json({ devices });
    return c.json({
      devices: devices.map((d) => ({ ...d, lastIngestStatus: d.lastIngestStatus?.startsWith('error') ? 'error' : d.lastIngestStatus })),
    });
  });

  /** Geofence boundaries for the org's readers — read off the events API, not the discovery logs. */
  api.get('/geofences', (c) => c.json({ geofences: deps.store.listGeofences(c.get('orgId')) }));

  /**
   * The live stream that replaced the Refresh button.
   *
   * It sits under the same org-scoping middleware as every other route here,
   * so it needs no auth of its own: no session is a 401, someone else's
   * organisation a 403, and an admin's `?orgId=` override works exactly as it
   * does on `/snapshots`.
   *
   * Each frame is a *signal*, never data — "this organisation has something
   * new" — and the client answers it by re-fetching through the ordinary
   * endpoints, which re-apply the whitelist and the device exclusions. That is
   * deliberate: one serialisation path, one place where filtering happens.
   *
   * The global `compress()` in `index.ts` leaves this alone — hono excludes
   * `text/event-stream` from its compressible types. If that ever stops being
   * true the stream will silently buffer and every frame will arrive late, in
   * a batch, which is a miserable thing to debug from the symptom.
   */
  api.get('/events', (c) => {
    const orgId = c.get('orgId');
    if (deps.bus.subscriberCount(orgId) >= deps.config.liveMaxSubscribersPerOrg) {
      return c.json({ error: 'Too many live connections for this organisation.' }, 503);
    }

    // `streamSSE` sets Content-Type, Cache-Control and Connection itself, and
    // does it after this point — so only the one it doesn't know about is set
    // here. It tells an nginx-family proxy (Railway's edge among them) not to
    // buffer the response, which would otherwise hold every frame back until
    // the stream ends.
    c.header('X-Accel-Buffering', 'no');

    return streamSSE(c, async (stream) => {
      // `publish` is synchronous and called from inside ingest transactions,
      // while `writeSSE` is async — so the listener never awaits. Writes are
      // queued onto a promise tail instead, which also keeps them in order.
      let tail: Promise<void> = Promise.resolve();
      const queue = (write: () => Promise<void>): void => {
        tail = tail.then(write).catch(() => {
          // A dead connection fails every subsequent write; `onAbort` is what
          // actually cleans up, so there is nothing useful to do here.
        });
      };

      const unsubscribe = deps.bus.subscribe(orgId, (event: LiveEvent) => {
        queue(() => stream.writeSSE({ event: event.type, data: JSON.stringify(event) }));
      });

      // Comment frames: they keep an idle-timeout proxy from closing the
      // connection, and give the client something to measure silence against.
      const heartbeat = setInterval(() => {
        queue(async () => {
          await stream.write(': ping\n\n');
        });
      }, deps.config.liveHeartbeatSeconds * 1000);

      const cleanup = (): void => {
        clearInterval(heartbeat);
        unsubscribe();
      };
      stream.onAbort(cleanup);

      try {
        await stream.writeSSE({
          event: 'hello',
          data: JSON.stringify({
            orgId,
            serverStartedAt: SERVER_STARTED_AT,
            heartbeatSeconds: deps.config.liveHeartbeatSeconds,
          }),
        });
        // Nothing to do but stay open — every later frame is written by the
        // subscription or the heartbeat above.
        await new Promise<void>((resolve) => stream.onAbort(resolve));
      } finally {
        cleanup();
      }
    });
  });

  return api;
}
