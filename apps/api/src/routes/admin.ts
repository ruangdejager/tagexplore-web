import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { parseTagIdList, type UserRole } from '@tagexplore/core';
import { currentUser } from '../auth/session.js';
import type { Config } from '../config.js';
import type { Store } from '../db/index.js';
import { ingestDevice } from '../ingest/ingest.js';

export interface AdminDeps {
  store: Store;
  config: Config;
}

const VALID_ROLES: readonly UserRole[] = ['user', 'admin'];
/** An IMEI is 15 digits; anything else is a typo, not a device. */
const IMEI_PATTERN = /^\d{14,16}$/;
const UNCLAIMED_WINDOW_MS = 30 * 86_400_000;

type Env = { Variables: { userId: string } };

export function createAdminApi(deps: AdminDeps): Hono<Env> {
  const api = new Hono<Env>();

  // Every route here needs an actual admin, not just a logged-in user —
  // checked once, centrally, rather than repeated per handler.
  api.use('*', async (c, next) => {
    const user = currentUser(c, deps.store);
    if (!user || user.role !== 'admin') return c.json({ error: 'Admin only.' }, 403);
    c.set('userId', user.id);
    await next();
  });

  // --- Organisations -------------------------------------------------------

  api.get('/orgs', (c) => c.json({ orgs: deps.store.listOrgs() }));

  api.post('/orgs', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const name = typeof body['name'] === 'string' ? body['name'].trim() : '';
    if (!name) return c.json({ error: 'An organisation needs a name.' }, 400);
    if (deps.store.getOrgByName(name)) return c.json({ error: 'There is already an organisation with that name.' }, 409);

    const id = nanoid(12);
    deps.store.createOrg(id, name);
    return c.json({ org: deps.store.getOrg(id) }, 201);
  });

  api.patch('/orgs/:id', async (c) => {
    const id = c.req.param('id');
    if (!deps.store.getOrg(id)) return c.json({ error: 'No organisation with that id.' }, 404);

    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const name = typeof body['name'] === 'string' ? body['name'].trim() : '';
    if (!name) return c.json({ error: 'An organisation needs a name.' }, 400);

    const clash = deps.store.getOrgByName(name);
    if (clash && clash.id !== id) return c.json({ error: 'There is already an organisation with that name.' }, 409);

    deps.store.renameOrg(id, name);
    return c.json({ ok: true });
  });

  api.delete('/orgs/:id', (c) => {
    const id = c.req.param('id');
    if (!deps.store.getOrg(id)) return c.json({ error: 'No organisation with that id.' }, 404);
    // Cascades to the organisation's devices and their readings, so this is
    // genuinely destructive — the UI asks before calling it.
    deps.store.deleteOrg(id);
    return c.json({ ok: true });
  });

  // --- Users ---------------------------------------------------------------

  api.get('/users', (c) => c.json({ users: deps.store.listUsers() }));

  api.patch('/users/:id', async (c) => {
    const targetId = c.req.param('id');
    const target = deps.store.getUserById(targetId);
    if (!target) return c.json({ error: 'No user with that id.' }, 404);

    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

    if ('role' in body) {
      const role = body['role'];
      if (typeof role !== 'string' || !VALID_ROLES.includes(role as UserRole)) {
        return c.json({ error: `role must be one of: ${VALID_ROLES.join(', ')}.` }, 400);
      }
      // The site has to always have at least one admin standing, or nobody could
      // ever grant the role back — including the person making this request, if
      // they are demoting themselves as the last one.
      if (target.role === 'admin' && role !== 'admin' && deps.store.countAdmins() <= 1) {
        return c.json({ error: "Can't remove the last admin." }, 409);
      }
      deps.store.setUserRole(targetId, role as UserRole);
    }

    if ('orgId' in body) {
      const orgId = body['orgId'];
      if (orgId !== null && typeof orgId !== 'string') {
        return c.json({ error: 'orgId must be an organisation id, or null to unassign.' }, 400);
      }
      if (typeof orgId === 'string' && !deps.store.getOrg(orgId)) {
        return c.json({ error: 'No organisation with that id.' }, 404);
      }
      deps.store.setUserOrg(targetId, orgId);
    }

    return c.json({ ok: true });
  });

  api.delete('/users/:id', (c) => {
    const targetId = c.req.param('id');
    const target = deps.store.getUserById(targetId);
    if (!target) return c.json({ error: 'No user with that id.' }, 404);
    if (target.role === 'admin' && deps.store.countAdmins() <= 1) {
      return c.json({ error: "Can't delete the last admin." }, 409);
    }
    deps.store.deleteUser(targetId);
    return c.json({ ok: true });
  });

  // --- Devices -------------------------------------------------------------

  api.get('/devices', (c) => c.json({ devices: deps.store.listDevices() }));

  api.post('/devices', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const imei = typeof body['imei'] === 'string' ? body['imei'].trim() : '';
    const orgId = typeof body['orgId'] === 'string' ? body['orgId'] : '';
    const label = typeof body['label'] === 'string' ? body['label'].trim() : '';

    if (!IMEI_PATTERN.test(imei)) return c.json({ error: 'An IMEI is 14-16 digits.' }, 400);
    if (!deps.store.getOrg(orgId)) return c.json({ error: 'No organisation with that id.' }, 404);
    if (deps.store.getDevice(imei)) return c.json({ error: 'That IMEI is already registered.' }, 409);

    deps.store.createDevice(imei, orgId, label);
    return c.json({ device: deps.store.getDevice(imei) }, 201);
  });

  api.patch('/devices/:imei', async (c) => {
    const imei = c.req.param('imei');
    if (!deps.store.getDevice(imei)) return c.json({ error: 'No device with that IMEI.' }, 404);

    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const patch: Parameters<Store['updateDevice']>[1] = {};

    if (typeof body['label'] === 'string') patch.label = body['label'].trim();
    if (typeof body['active'] === 'boolean') patch.active = body['active'];
    if (typeof body['orgId'] === 'string') {
      if (!deps.store.getOrg(body['orgId'])) return c.json({ error: 'No organisation with that id.' }, 404);
      patch.orgId = body['orgId'];
    }

    const whole = (key: string, min: number, max: number): number | null => {
      const value = body[key];
      if (value === undefined) return null;
      const n = Number(value);
      if (!Number.isFinite(n) || n < min || n > max) throw new RangeError(`${key} must be between ${min} and ${max}.`);
      return Math.round(n);
    };

    try {
      // The same three numbers the settings API reports, editable by hand for a
      // device whose settings we cannot read.
      const start = whole('reportStartMinute', 0, 24 * 60 - 1);
      const interval = whole('reportIntervalMinutes', 1, 24 * 60);
      const count = whole('reportCountPerDay', 1, 24 * 60);
      const offset = whole('pollOffsetMinutes', 0, 24 * 60);
      if (start !== null) patch.reportStartMinute = start;
      if (interval !== null) patch.reportIntervalMinutes = interval;
      if (count !== null) patch.reportCountPerDay = count;
      if (offset !== null) patch.pollOffsetMinutes = offset;
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Invalid schedule.' }, 400);
    }

    deps.store.updateDevice(imei, patch);
    return c.json({ device: deps.store.getDevice(imei) });
  });

  api.delete('/devices/:imei', (c) => {
    const imei = c.req.param('imei');
    if (!deps.store.getDevice(imei)) return c.json({ error: 'No device with that IMEI.' }, 404);
    deps.store.deleteDevice(imei);
    return c.json({ ok: true });
  });

  /** Reads this device's log right now instead of waiting for its next slot. */
  api.post('/devices/:imei/ingest', async (c) => {
    const imei = c.req.param('imei');
    if (!deps.store.getDevice(imei)) return c.json({ error: 'No device with that IMEI.' }, 404);
    try {
      const result = await ingestDevice(deps.store, deps.config, imei);
      return c.json({ result: { ...result, from: result.from.toISOString(), to: result.to.toISOString() } });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Ingest failed.' }, 502);
    }
  });

  api.get('/ingest-runs', (c) => {
    const imei = c.req.query('imei');
    const limit = Math.min(200, Number(c.req.query('limit') ?? 50) || 50);
    return c.json({ runs: deps.store.listIngestRuns(limit, imei) });
  });

  // --- Tag whitelist -------------------------------------------------------

  api.get('/orgs/:id/tags', (c) => {
    const orgId = c.req.param('id');
    if (!deps.store.getOrg(orgId)) return c.json({ error: 'No organisation with that id.' }, 404);
    return c.json({ tags: deps.store.listOrgTags(orgId) });
  });

  api.post('/orgs/:id/tags', async (c) => {
    const orgId = c.req.param('id');
    if (!deps.store.getOrg(orgId)) return c.json({ error: 'No organisation with that id.' }, 404);

    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    // Accepts either a pasted blob of IDs or a JSON array, since the admin
    // screen offers a textarea and the unclaimed-tag list sends a selection.
    const raw = body['tagIds'];
    const { ids, invalid } = parseTagIdList(
      Array.isArray(raw) ? (raw as string[]) : typeof raw === 'string' ? raw : '',
    );
    if (ids.length === 0) {
      return c.json({ error: invalid.length ? `Not tag IDs: ${invalid.join(', ')}` : 'No tag IDs given.' }, 400);
    }

    const added = deps.store.addOrgTags(orgId, ids);
    return c.json({ added, skipped: ids.length - added, invalid, tags: deps.store.listOrgTags(orgId) }, 201);
  });

  api.patch('/orgs/:id/tags/:tagId', async (c) => {
    const orgId = c.req.param('id');
    const tagId = c.req.param('tagId').toUpperCase();
    if (!deps.store.getOrg(orgId)) return c.json({ error: 'No organisation with that id.' }, 404);

    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const label = typeof body['label'] === 'string' ? body['label'].trim() : '';
    deps.store.setOrgTagLabel(orgId, tagId, label || null);
    return c.json({ ok: true });
  });

  api.delete('/orgs/:id/tags/:tagId', (c) => {
    const orgId = c.req.param('id');
    const tagId = c.req.param('tagId').toUpperCase();
    // Readings stay — only the organisation's claim on the tag goes away, so
    // re-adding it later brings its whole history back with it.
    deps.store.removeOrgTag(orgId, tagId);
    return c.json({ ok: true });
  });

  api.get('/unclaimed-tags', (c) => {
    const orgId = c.req.query('orgId');
    const since = Date.now() - UNCLAIMED_WINDOW_MS;
    return c.json({ tags: deps.store.listUnclaimedTags(since, orgId) });
  });

  return api;
}
