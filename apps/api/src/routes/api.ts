import { Hono } from 'hono';
import { parseTagIdList } from '@tagexplore/core';
import { currentUser } from '../auth/session.js';
import type { Config } from '../config.js';
import type { Store, UserRow } from '../db/index.js';
import { refreshDeviceFully } from '../ingest/ingest.js';

export interface ApiDeps {
  store: Store;
  config: Config;
}

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

  /** Latest state of every whitelisted tag heard in the window: the map and the sidebar. */
  api.get('/snapshots', (c) => {
    const window = readWindow(c.req.query(), Date.now());
    if ('error' in window) return c.json({ error: window.error }, 400);

    return c.json({
      from: window.from,
      to: window.to,
      snapshots: deps.store.tagSnapshots({ orgId: c.get('orgId'), ...window }, parseExcludeDeviceImeis(c.req.query())),
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
   * a tag. `at` (epoch ms) swaps each reader's position for wherever it was as
   * of that time instead of its current one — a past discovery round's own
   * purple marker, not today's.
   */
  api.get('/devices', (c) => {
    let devices = deps.store.listDevices(c.get('orgId'));

    const atRaw = c.req.query('at');
    if (atRaw !== undefined) {
      const at = Number(atRaw);
      if (!Number.isFinite(at)) return c.json({ error: '`at` must be epoch milliseconds.' }, 400);
      devices = devices.map((d) => {
        const position = deps.store.getDevicePositionAt(d.imei, at);
        return { ...d, lat: position?.lat ?? null, lon: position?.lon ?? null, gpsUpdatedAt: position?.reportedAt ?? null };
      });
    }

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
   * What "Refresh" in the main app actually means: not a re-read of whatever
   * is already in the database, but a live pull — schedule, log, position and
   * geofences — for every one of this organisation's active readers, run in
   * parallel. The client re-fetches its own snapshots/devices/geofences
   * afterward; this just makes sure there is something new to find.
   */
  api.post('/refresh', async (c) => {
    const orgId = c.get('orgId');
    const devices = deps.store.listDevices(orgId).filter((d) => d.active);
    const outcomes = await Promise.allSettled(devices.map((d) => refreshDeviceFully(deps.store, deps.config, d.imei)));
    const devicesResult = outcomes.map((outcome, i) => ({
      imei: (devices[i] as (typeof devices)[number]).imei,
      ok: outcome.status === 'fulfilled',
      error: outcome.status === 'rejected' ? (outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)) : null,
    }));
    return c.json({ devices: devicesResult });
  });

  return api;
}
