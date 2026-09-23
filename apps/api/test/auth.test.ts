import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuthUser, DiscoveryDetail } from '@tagexplore/core';
import { loadConfig, type Config } from '../src/config.js';
import { Store } from '../src/db/index.js';
import { createLiveBus, type LiveBus } from '../src/events/bus.js';
import { createAccountApi } from '../src/routes/account.js';
import { createAdminApi } from '../src/routes/admin.js';
import { createApi } from '../src/routes/api.js';
import { createAuthApi } from '../src/routes/auth.js';

let dir: string;
let store: Store;
let config: Config;
let bus: LiveBus;
let app: Hono;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tagexplore-auth-'));
  store = new Store(join(dir, 'test.db'), 'founder');
  config = loadConfig();
  bus = createLiveBus();

  app = new Hono();
  app.route('/api/auth', createAuthApi({ store, cookieSecure: false }));
  app.route('/api/account', createAccountApi({ store }));
  app.route('/api/admin', createAdminApi({ store, config, bus }));
  app.route('/api', createApi({ store, config, bus }));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function post(path: string, body: unknown, cookie?: string): Promise<Response> {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

function get(path: string, cookie?: string): Promise<Response> {
  return app.request(path, { headers: cookie ? { cookie } : {} });
}

function patch(path: string, body: unknown, cookie?: string): Promise<Response> {
  return app.request(path, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

function put(path: string, body: unknown, cookie?: string): Promise<Response> {
  return app.request(path, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

/** Signs an account up and returns the session cookie the browser would keep. */
async function signup(username: string, password = 'correct horse battery'): Promise<string> {
  const res = await post('/api/auth/signup', { username, password });
  expect(res.status).toBe(201);
  return (res.headers.get('set-cookie') ?? '').split(';')[0] as string;
}

describe('signup and login', () => {
  it('creates an account that is signed in but has no organisation yet', async () => {
    const cookie = await signup('shepherd');
    const me = (await (await get('/api/auth/me', cookie)).json()) as { user: AuthUser };
    expect(me.user).toMatchObject({ username: 'shepherd', role: 'client', orgs: [] });
  });

  it('rejects a short password and a taken username', async () => {
    expect((await post('/api/auth/signup', { username: 'shepherd', password: 'short' })).status).toBe(400);
    await signup('shepherd');
    expect((await post('/api/auth/signup', { username: 'shepherd', password: 'correct horse battery' })).status).toBe(409);
  });

  it('gives the same answer for a wrong username as for a wrong password', async () => {
    await signup('shepherd');
    const wrongUser = await post('/api/auth/login', { username: 'nobody', password: 'correct horse battery' });
    const wrongPass = await post('/api/auth/login', { username: 'shepherd', password: 'wrong wrong wrong' });

    expect(wrongUser.status).toBe(401);
    expect(wrongPass.status).toBe(401);
    expect(await wrongUser.json()).toEqual(await wrongPass.json());
  });

  it('ends the session on logout', async () => {
    const cookie = await signup('shepherd');
    await post('/api/auth/logout', {}, cookie);
    const me = (await (await get('/api/auth/me', cookie)).json()) as { user: AuthUser | null };
    expect(me.user).toBeNull();
  });

  it('promotes the founding admin on boot, and only ever grants', async () => {
    await signup('founder');
    // The account existed as a plain user until the next boot picked it up.
    store.close();
    store = new Store(join(dir, 'test.db'), 'founder');
    expect(store.getUserByUsername('founder')?.role).toBe('admin');
  });
});

describe('access control', () => {
  it('keeps a logged-out visitor out of the data and the admin API', async () => {
    expect((await get('/api/snapshots')).status).toBe(401);
    expect((await get('/api/admin/orgs')).status).toBe(403);
  });

  it('tells a user with no organisation why they see nothing', async () => {
    const cookie = await signup('shepherd');
    const res = await get('/api/snapshots', cookie);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/not in an organisation/i);
  });

  it('keeps a plain user out of the admin API', async () => {
    const cookie = await signup('shepherd');
    expect((await get('/api/admin/orgs', cookie)).status).toBe(403);
    expect((await post('/api/admin/orgs', { name: 'Sneaky Farms' }, cookie)).status).toBe(403);
  });

  it('defaults to the first organisation a user belongs to, and lets them switch among their own', async () => {
    const userCookie = await signup('shepherd');
    store.createOrg('org-a', 'Org A');
    store.createOrg('org-b', 'Org B');
    store.setUserOrgs(store.getUserByUsername('shepherd')!.id, ['org-a', 'org-b']);
    store.addOrgTags('org-a', ['3E1E']);
    store.addOrgTags('org-b', ['441F']);

    const byDefault = (await (await get('/api/tags', userCookie)).json()) as { tags: Array<{ tagId: string }> };
    expect(byDefault.tags.map((t) => t.tagId)).toEqual(['3E1E']);

    const switched = (await (await get('/api/tags?orgId=org-b', userCookie)).json()) as { tags: Array<{ tagId: string }> };
    expect(switched.tags.map((t) => t.tagId)).toEqual(['441F']);
  });

  it('refuses an organisation the user does not belong to, rather than silently falling back', async () => {
    const userCookie = await signup('shepherd');
    store.createOrg('org-a', 'Org A');
    store.createOrg('org-b', 'Org B');
    store.setUserOrgs(store.getUserByUsername('shepherd')!.id, ['org-a']);
    store.addOrgTags('org-b', ['441F']);

    const res = await get('/api/tags?orgId=org-b', userCookie);
    expect(res.status).toBe(403);
  });

  it('lets an admin look at any organisation', async () => {
    const cookie = await signup('founder');
    store.setUserRole(store.getUserByUsername('founder')!.id, 'admin');
    store.createOrg('org-b', 'Org B');
    store.addOrgTags('org-b', ['441F']);

    const res = (await (await get('/api/tags?orgId=org-b', cookie)).json()) as { tags: Array<{ tagId: string }> };
    expect(res.tags.map((t) => t.tagId)).toEqual(['441F']);
  });
});

describe('admin API', () => {
  let cookie: string;

  beforeEach(async () => {
    cookie = await signup('founder');
    store.setUserRole(store.getUserByUsername('founder')!.id, 'admin');
  });

  it('creates organisations, devices and whitelist entries', async () => {
    const org = (await (await post('/api/admin/orgs', { name: 'Groenvley' }, cookie)).json()) as {
      org: { id: string };
    };
    const deviceRes = await post(
      '/api/admin/devices',
      { imei: '866049074634379', orgId: org.org.id, label: 'North reader' },
      cookie,
    );
    expect(deviceRes.status).toBe(201);

    const tagRes = await post(`/api/admin/orgs/${org.org.id}/tags`, { tagIds: '3e1e, 441f 3E1E' }, cookie);
    expect(tagRes.status).toBe(201);
    expect((await tagRes.json()) as { added: number }).toMatchObject({ added: 2 });
  });

  it('rejects a malformed IMEI and a duplicate one', async () => {
    const org = (await (await post('/api/admin/orgs', { name: 'Groenvley' }, cookie)).json()) as {
      org: { id: string };
    };
    expect((await post('/api/admin/devices', { imei: 'not-an-imei', orgId: org.org.id }, cookie)).status).toBe(400);
    await post('/api/admin/devices', { imei: '866049074634379', orgId: org.org.id }, cookie);
    expect((await post('/api/admin/devices', { imei: '866049074634379', orgId: org.org.id }, cookie)).status).toBe(409);
  });

  it('tells an empty carried tag apart from a stated absence', async () => {
    const org = (await (await post('/api/admin/orgs', { name: 'Groenvley' }, cookie)).json()) as {
      org: { id: string };
    };
    const imei = '866049074634379';
    await post('/api/admin/devices', { imei, orgId: org.org.id, carriedTagId: '3E1E' }, cookie);

    // An empty string hands the field back to the inference.
    await patch(`/api/admin/devices/${imei}`, { carriedTagId: '' }, cookie);
    expect(store.getDevice(imei)).toMatchObject({ carriedTagId: null, carriedTagSource: null });

    // A JSON null says there is no tag to find, and latches that.
    await patch(`/api/admin/devices/${imei}`, { carriedTagId: null }, cookie);
    expect(store.getDevice(imei)).toMatchObject({ carriedTagId: null, carriedTagSource: 'manual' });
    store.applyInferredCarriedTag(imei, 'AAAA');
    expect(store.getDevice(imei)?.carriedTagId).toBeNull();
  });

  it('refuses to remove the last admin', async () => {
    const id = store.getUserByUsername('founder')!.id;
    const res = await patch(`/api/admin/users/${id}`, { role: 'client' }, cookie);
    expect(res.status).toBe(409);
    expect(store.getUserByUsername('founder')?.role).toBe('admin');
  });

  it('creates a user directly, already placed in organisations, with a working password', async () => {
    store.createOrg('org-a', 'Groenvley');
    store.createOrg('org-b', 'Bosveld');

    const res = await post(
      '/api/admin/users',
      { username: 'newhand', password: 'a working password', role: 'dev', orgIds: ['org-a', 'org-b'] },
      cookie,
    );
    expect(res.status).toBe(201);

    const login = await post('/api/auth/login', { username: 'newhand', password: 'a working password' });
    expect(login.status).toBe(200);

    const created = store.getUserByUsername('newhand')!;
    expect(created.role).toBe('dev');
    expect(store.listOrgsForUser(created.id).map((o) => o.id).sort()).toEqual(['org-a', 'org-b']);
  });

  it('rejects creating a user with a name already taken or an unknown organisation', async () => {
    await signup('shepherd');
    expect((await post('/api/admin/users', { username: 'shepherd', password: 'a working password' }, cookie)).status).toBe(
      409,
    );
    expect(
      (await post('/api/admin/users', { username: 'fresh', password: 'a working password', orgIds: ['nope'] }, cookie))
        .status,
    ).toBe(404);
  });

  it('adds one organisation to a user without touching the others', async () => {
    store.createOrg('org-a', 'Groenvley');
    store.createOrg('org-b', 'Bosveld');
    const userCookie = await signup('shepherd');
    store.setUserOrgs(store.getUserByUsername('shepherd')!.id, ['org-a']);
    const userId = store.getUserByUsername('shepherd')!.id;

    const res = await post(`/api/admin/users/${userId}/orgs`, { orgId: 'org-b' }, cookie);
    expect(res.status).toBe(201);
    expect(store.listOrgsForUser(userId).map((o) => o.id).sort()).toEqual(['org-a', 'org-b']);

    // Both memberships work — adding one never displaces another.
    expect((await get('/api/tags?orgId=org-a', userCookie)).status).not.toBe(403);
    expect((await get('/api/tags?orgId=org-b', userCookie)).status).not.toBe(403);
  });

  it('removes one organisation from a user without touching the others', async () => {
    store.createOrg('org-a', 'Groenvley');
    store.createOrg('org-b', 'Bosveld');
    const userCookie = await signup('shepherd');
    store.setUserOrgs(store.getUserByUsername('shepherd')!.id, ['org-a', 'org-b']);
    const userId = store.getUserByUsername('shepherd')!.id;

    const res = await app.request(`/api/admin/users/${userId}/orgs/org-a`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    expect(store.listOrgsForUser(userId).map((o) => o.id)).toEqual(['org-b']);
    expect((await get('/api/tags?orgId=org-a', userCookie)).status).toBe(403);
  });

  it('sets a user’s password without needing the old one', async () => {
    const userCookie = await signup('shepherd');
    const id = store.getUserByUsername('shepherd')!.id;

    const res = await patch(`/api/admin/users/${id}/password`, { password: 'a brand new password' }, cookie);
    expect(res.status).toBe(200);

    expect((await post('/api/auth/login', { username: 'shepherd', password: 'correct horse battery' })).status).toBe(401);
    expect((await post('/api/auth/login', { username: 'shepherd', password: 'a brand new password' })).status).toBe(200);
  });
});

describe('organisation access requests', () => {
  it('lists orgs for a user with no organisation, by name only', async () => {
    store.createOrg('org-a', 'Groenvley');
    const cookie = await signup('shepherd');
    const res = (await (await get('/api/account/orgs', cookie)).json()) as { orgs: Array<{ id: string; name: string }> };
    expect(res.orgs).toEqual([{ id: 'org-a', name: 'Groenvley' }]);
  });

  it('lets a user with no org request one, and reports it back as pending', async () => {
    store.createOrg('org-a', 'Groenvley');
    const cookie = await signup('shepherd');

    const res = await post('/api/account/org-request', { orgId: 'org-a' }, cookie);
    expect(res.status).toBe(201);

    const mine = (await (await get('/api/account/org-request', cookie)).json()) as {
      request: { status: string; orgId: string } | null;
    };
    expect(mine.request).toMatchObject({ status: 'pending', orgId: 'org-a' });
  });

  it('refuses a second pending request from the same user', async () => {
    store.createOrg('org-a', 'Groenvley');
    store.createOrg('org-b', 'Bosveld');
    const cookie = await signup('shepherd');

    await post('/api/account/org-request', { orgId: 'org-a' }, cookie);
    const second = await post('/api/account/org-request', { orgId: 'org-b' }, cookie);
    expect(second.status).toBe(409);
  });

  it('refuses a request for an organisation the user already belongs to', async () => {
    store.createOrg('org-a', 'Groenvley');
    const cookie = await signup('shepherd');
    store.setUserOrgs(store.getUserByUsername('shepherd')!.id, ['org-a']);

    const res = await post('/api/account/org-request', { orgId: 'org-a' }, cookie);
    expect(res.status).toBe(409);
  });

  it('lets a user who already belongs to one organisation request a second', async () => {
    store.createOrg('org-a', 'Groenvley');
    store.createOrg('org-b', 'Bosveld');
    const cookie = await signup('shepherd');
    store.setUserOrgs(store.getUserByUsername('shepherd')!.id, ['org-a']);

    const res = await post('/api/account/org-request', { orgId: 'org-b' }, cookie);
    expect(res.status).toBe(201);
  });

  it('keeps org-request routes out of reach for a logged-out visitor', async () => {
    expect((await get('/api/account/orgs')).status).toBe(401);
    expect((await post('/api/account/org-request', { orgId: 'org-a' })).status).toBe(401);
  });

  it('lets an admin approve a request, which places the user in the org', async () => {
    store.createOrg('org-a', 'Groenvley');
    const userCookie = await signup('shepherd');
    await post('/api/account/org-request', { orgId: 'org-a' }, userCookie);

    const adminCookie = await signup('founder');
    store.setUserRole(store.getUserByUsername('founder')!.id, 'admin');

    const pending = (await (await get('/api/admin/org-requests', adminCookie)).json()) as {
      requests: Array<{ id: number; username: string; orgName: string | null }>;
    };
    expect(pending.requests).toHaveLength(1);
    expect(pending.requests[0]).toMatchObject({ username: 'shepherd', orgName: 'Groenvley' });

    const approve = await post(`/api/admin/org-requests/${pending.requests[0]!.id}/approve`, {}, adminCookie);
    expect(approve.status).toBe(200);

    expect(store.listOrgsForUser(store.getUserByUsername('shepherd')!.id).map((o) => o.id)).toEqual(['org-a']);
    // Resolved requests drop off the pending queue.
    const after = (await (await get('/api/admin/org-requests', adminCookie)).json()) as { requests: unknown[] };
    expect(after.requests).toHaveLength(0);
  });

  it('lets an admin reject a request without touching the user’s organisation', async () => {
    store.createOrg('org-a', 'Groenvley');
    const userCookie = await signup('shepherd');
    await post('/api/account/org-request', { orgId: 'org-a' }, userCookie);

    const adminCookie = await signup('founder');
    store.setUserRole(store.getUserByUsername('founder')!.id, 'admin');
    const pending = (await (await get('/api/admin/org-requests', adminCookie)).json()) as {
      requests: Array<{ id: number }>;
    };

    const reject = await post(`/api/admin/org-requests/${pending.requests[0]!.id}/reject`, {}, adminCookie);
    expect(reject.status).toBe(200);
    expect(store.listOrgsForUser(store.getUserByUsername('shepherd')!.id)).toEqual([]);

    // Rejected, not pending forever — the user can ask again.
    const again = await post('/api/account/org-request', { orgId: 'org-a' }, userCookie);
    expect(again.status).toBe(201);
  });

  it('keeps the org-request admin endpoints out of reach for a non-admin', async () => {
    const cookie = await signup('shepherd');
    expect((await get('/api/admin/org-requests', cookie)).status).toBe(403);
    expect((await post('/api/admin/org-requests/1/approve', {}, cookie)).status).toBe(403);
  });
});

describe('user preferences', () => {
  it('defaults to nothing hidden, the discovery legend and no remembered org before anything is saved', async () => {
    const cookie = await signup('shepherd');
    const res = await get('/api/account/preferences', cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      preferences: { colorMode: 'discovery', lastOrgId: null, geofencesView: false, hiddenDeviceImeis: [] },
    });
  });

  it('saves this user’s toggles and last-viewed org and hands them back on the next fetch', async () => {
    const cookie = await signup('shepherd');
    const saved = await put(
      '/api/account/preferences',
      {
        colorMode: 'latestGps',
        lastOrgId: 'org-a',
        geofencesView: true,
        hiddenDeviceImeis: ['866049074634338'],
      },
      cookie,
    );
    expect(saved.status).toBe(200);

    const res = await get('/api/account/preferences', cookie);
    expect(await res.json()).toEqual({
      preferences: {
        colorMode: 'latestGps',
        lastOrgId: 'org-a',
        geofencesView: true,
        hiddenDeviceImeis: ['866049074634338'],
      },
    });
  });

  it('defaults a preferences row saved before geofencesView/hiddenDeviceImeis existed to "off"/"none hidden" rather than resetting it', async () => {
    const cookie = await signup('shepherd');
    await put('/api/account/preferences', { colorMode: 'age', lastOrgId: 'org-a' }, cookie);

    const res = await get('/api/account/preferences', cookie);
    expect(await res.json()).toEqual({
      preferences: { colorMode: 'age', lastOrgId: 'org-a', geofencesView: false, hiddenDeviceImeis: [] },
    });
  });

  // Tags moved from here to `org_tags.hidden`, so a row still carrying the old
  // field has to keep validating — otherwise every existing user's colour mode
  // and remembered org would reset along with it.
  it('ignores a leftover hiddenTagIds rather than rejecting the whole row', async () => {
    const cookie = await signup('shepherd');
    const saved = await put(
      '/api/account/preferences',
      { hiddenTagIds: ['3E1E'], colorMode: 'age', lastOrgId: 'org-a' },
      cookie,
    );
    expect(saved.status).toBe(200);

    const res = await get('/api/account/preferences', cookie);
    expect(await res.json()).toEqual({
      preferences: { colorMode: 'age', lastOrgId: 'org-a', geofencesView: false, hiddenDeviceImeis: [] },
    });
  });

  it('keeps each user’s preferences separate from the others', async () => {
    const shepherdCookie = await signup('shepherd');
    const otherCookie = await signup('other');
    await put(
      '/api/account/preferences',
      { colorMode: 'age', lastOrgId: 'org-a', geofencesView: true, hiddenDeviceImeis: ['866049074634338'] },
      shepherdCookie,
    );

    const res = await get('/api/account/preferences', otherCookie);
    expect(await res.json()).toEqual({
      preferences: { colorMode: 'discovery', lastOrgId: null, geofencesView: false, hiddenDeviceImeis: [] },
    });
  });

  it('rejects a malformed body rather than saving it', async () => {
    const cookie = await signup('shepherd');
    const res = await put(
      '/api/account/preferences',
      { colorMode: 'not-a-legend', lastOrgId: null },
      cookie,
    );
    expect(res.status).toBe(400);
  });

  it('requires a session', async () => {
    expect((await get('/api/account/preferences')).status).toBe(401);
  });
});

/**
 * The raw-data view behind a count-history row. It exposes stored column values
 * and readings for tags outside the whitelist, so who may open it is part of
 * the contract, not just a UI choice.
 */
describe('GET /api/discovery-detail', () => {
  const ORG = 'org-a';
  const IMEI = '866049074634379';
  const BRACKET = Date.parse('2026-09-18T12:15:00Z');
  const ARRIVED = BRACKET + 37_000;

  /** Signs an account up and puts it in the organisation at the given role. */
  async function member(username: string, role: 'client' | 'dev' | 'admin'): Promise<string> {
    const cookie = await signup(username);
    const user = store.getUserByUsername(username);
    if (!user) throw new Error('signup did not create the user');
    store.addUserOrg(user.id, ORG);
    store.setUserRole(user.id, role);
    return cookie;
  }

  beforeEach(() => {
    store.createOrg(ORG, 'Org A');
    store.createDevice(IMEI, ORG, 'Reader 379');
    store.addOrgTags(ORG, ['3E1E']);
  });

  /** One round that was pushed to us, and one tag nobody has whitelisted. */
  function writePushedRound(): void {
    store.writeTagDiscoveryPost({
      deviceImei: IMEI,
      primaryDeviceId: 0x00a1b2c3,
      sessionUtc: Math.floor(BRACKET / 1000),
      receivedAt: ARRIVED,
      bracketAt: BRACKET,
      mode: 0,
      primaryVersion: 20400,
      byteCount: 65,
      readings: [
        {
          bracketAt: BRACKET,
          deviceImei: IMEI,
          tagId: '3E1E',
          batteryMv: 4012,
          rssi: -87,
          hops: 1,
          waveCount: 2,
          movementState: 1,
          lat: null,
          lon: null,
          hasGps: false,
          fwPatch: 8,
          gpsAgeSeconds: null,
          linkId: null,
          source: 'cbor',
        },
        {
          bracketAt: BRACKET,
          deviceImei: IMEI,
          tagId: '441F',
          batteryMv: 3900,
          rssi: -70,
          hops: 1,
          waveCount: 1,
          movementState: 0,
          lat: null,
          lon: null,
          hasGps: false,
          fwPatch: 8,
          gpsAgeSeconds: null,
          linkId: null,
          source: 'cbor',
        },
      ],
      round: {
        bracketAt: BRACKET,
        deviceImei: IMEI,
        tagCount: 2,
        durationSeconds: 52,
        unitBatteryMv: null,
        readerFw: 'v2.4.0',
        timedOut: false,
        source: 'cbor',
        receivedAt: ARRIVED,
      },
    });
  }

  it('gives a dev the round, its arrival time, its CBOR receipt and every raw reading', async () => {
    writePushedRound();
    const cookie = await member('tinkerer', 'dev');

    const res = await get(`/api/discovery-detail?orgId=${ORG}&at=${BRACKET}`, cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as DiscoveryDetail;

    expect(body.bracketAt).toBe(BRACKET);
    expect(body.rounds).toHaveLength(1);
    expect(body.rounds[0]).toMatchObject({
      deviceImei: IMEI,
      deviceLabel: 'Reader 379',
      source: 'cbor',
      receivedAt: ARRIVED,
      durationSeconds: 52,
    });
    expect(body.rounds[0]?.post).toMatchObject({ mode: 0, primaryVersion: 20400, recordCount: 2, byteCount: 65 });
    // Unaggregated and unfiltered — '441F' is not on the whitelist, and seeing
    // that it arrived anyway is half the point of this view. It leads because
    // it is a wave earlier, not because of its id.
    expect(body.readings.map((r) => r.tagId)).toEqual(['441F', '3E1E']);
    expect(body.readings[1]).toMatchObject({ source: 'cbor', batteryMv: 4012, rssi: -87 });
  });

  it('says a scraped round has no arrival time rather than inventing one', async () => {
    store.writeReadings(
      [],
      [
        {
          bracketAt: BRACKET,
          deviceImei: IMEI,
          tagCount: 1,
          durationSeconds: 86,
          unitBatteryMv: 4019,
          readerFw: 'v2.4.0',
          timedOut: false,
          source: 'log',
          receivedAt: null,
        },
      ],
    );
    const cookie = await member('tinkerer', 'dev');

    const body = (await (await get(`/api/discovery-detail?orgId=${ORG}&at=${BRACKET}`, cookie)).json()) as DiscoveryDetail;
    expect(body.rounds[0]).toMatchObject({ source: 'log', receivedAt: null, durationSeconds: 86 });
    expect(body.rounds[0]?.post).toBeNull();
  });

  it('refuses a client account', async () => {
    writePushedRound();
    const cookie = await member('shepherd', 'client');
    expect((await get(`/api/discovery-detail?orgId=${ORG}&at=${BRACKET}`, cookie)).status).toBe(403);
  });

  it('rejects a missing or unparseable `at`', async () => {
    const cookie = await member('tinkerer', 'dev');
    expect((await get(`/api/discovery-detail?orgId=${ORG}`, cookie)).status).toBe(400);
    expect((await get(`/api/discovery-detail?orgId=${ORG}&at=soon`, cookie)).status).toBe(400);
  });

  it('requires a session', async () => {
    expect((await get(`/api/discovery-detail?orgId=${ORG}&at=${BRACKET}`)).status).toBe(401);
  });
});

describe('organisation-wide tag toggle', () => {
  /** Two members of one organisation, so "does the other one see it" is askable. */
  async function twoMembers(): Promise<{ first: string; second: string }> {
    const first = await signup('shepherd');
    const second = await signup('herder');
    store.createOrg('org-a', 'Org A');
    store.setUserOrgs(store.getUserByUsername('shepherd')!.id, ['org-a']);
    store.setUserOrgs(store.getUserByUsername('herder')!.id, ['org-a']);
    store.addOrgTags('org-a', ['3E1E', '441F']);
    return { first, second };
  }

  const tagsOf = async (cookie: string): Promise<Array<{ tagId: string; hidden: boolean }>> =>
    ((await (await get('/api/tags?orgId=org-a', cookie)).json()) as { tags: Array<{ tagId: string; hidden: boolean }> })
      .tags;

  it('starts with every tag switched on', async () => {
    const { first } = await twoMembers();
    expect(await tagsOf(first)).toMatchObject([{ tagId: '3E1E', hidden: false }, { tagId: '441F', hidden: false }]);
  });

  it('shows one member’s toggle to everyone else in the organisation', async () => {
    // The whole point of moving this off a user preference: a count of 27/28
    // that is really 27/27 has to read that way for everyone, not only for
    // whoever noticed the dead tag.
    const { first, second } = await twoMembers();

    const res = await patch('/api/tags/3E1E?orgId=org-a', { hidden: true }, first);
    expect(res.status).toBe(200);

    expect(await tagsOf(second)).toMatchObject([{ tagId: '3E1E', hidden: true }, { tagId: '441F', hidden: false }]);
  });

  it('switches back on again', async () => {
    const { first } = await twoMembers();
    await patch('/api/tags/3E1E?orgId=org-a', { hidden: true }, first);
    await patch('/api/tags/3E1E?orgId=org-a', { hidden: false }, first);
    expect((await tagsOf(first))[0]).toMatchObject({ tagId: '3E1E', hidden: false });
  });

  it('announces the change, so other open browsers re-read', async () => {
    const { first } = await twoMembers();
    const seen: string[] = [];
    bus.subscribe('org-a', (e) => seen.push(e.type));

    await patch('/api/tags/3E1E?orgId=org-a', { hidden: true }, first);
    expect(seen).toEqual(['tags']);
  });

  it('keeps organisations apart', async () => {
    const { first } = await twoMembers();
    const outsider = await signup('neighbour');
    store.createOrg('org-b', 'Org B');
    store.setUserOrgs(store.getUserByUsername('neighbour')!.id, ['org-b']);
    store.addOrgTags('org-b', ['3E1E']);

    await patch('/api/tags/3E1E?orgId=org-a', { hidden: true }, first);

    const theirs = (await (await get('/api/tags?orgId=org-b', outsider)).json()) as {
      tags: Array<{ hidden: boolean }>;
    };
    expect(theirs.tags[0]?.hidden).toBe(false);
  });

  it('refuses a tag this organisation has not claimed, and a body that says nothing', async () => {
    const { first } = await twoMembers();
    expect((await patch('/api/tags/9999?orgId=org-a', { hidden: true }, first)).status).toBe(404);
    expect((await patch('/api/tags/3E1E?orgId=org-a', {}, first)).status).toBe(400);
  });

  it('refuses an organisation the user is not in, and requires a session', async () => {
    await twoMembers();
    const outsider = await signup('neighbour');
    expect((await patch('/api/tags/3E1E?orgId=org-a', { hidden: true }, outsider)).status).toBe(403);
    expect((await patch('/api/tags/3E1E?orgId=org-a', { hidden: true })).status).toBe(401);
  });
});

describe('GET /api/events', () => {
  it('requires a session', async () => {
    expect((await get('/api/events')).status).toBe(401);
  });

  it('refuses an organisation the user is not in', async () => {
    const cookie = await signup('shepherd');
    store.createOrg('org-a', 'Org A');
    store.createOrg('org-b', 'Org B');
    store.setUserOrgs(store.getUserByUsername('shepherd')!.id, ['org-a']);

    expect((await get('/api/events?orgId=org-b', cookie)).status).toBe(403);
  });

  it('opens a stream and greets with this process’s identity', async () => {
    const cookie = await signup('shepherd');
    store.createOrg('org-a', 'Org A');
    store.setUserOrgs(store.getUserByUsername('shepherd')!.id, ['org-a']);

    const res = await get('/api/events?orgId=org-a', cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const reader = res.body!.getReader();
    try {
      const { value } = await reader.read();
      const frame = new TextDecoder().decode(value);
      expect(frame).toContain('event: hello');
      // `serverStartedAt` is what lets a reconnecting client tell "same
      // process" from "redeployed while I was away".
      expect(frame).toContain('serverStartedAt');
      expect(frame).toContain('org-a');
    } finally {
      await reader.cancel();
    }
  });

  it('delivers this organisation’s events and nobody else’s', async () => {
    const cookie = await signup('shepherd');
    store.createOrg('org-a', 'Org A');
    store.setUserOrgs(store.getUserByUsername('shepherd')!.id, ['org-a']);

    const res = await get('/api/events?orgId=org-a', cookie);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    try {
      await reader.read(); // the hello frame

      bus.publish({ type: 'readings', orgId: 'org-b', imei: '1', at: Date.now() });
      bus.publish({ type: 'readings', orgId: 'org-a', imei: '866049074634379', at: Date.now(), bracketAt: 42 });

      const { value } = await reader.read();
      const frame = decoder.decode(value);
      // The org-b publish must not appear at all — the first frame after hello
      // is the org-a one.
      expect(frame).toContain('event: readings');
      expect(frame).toContain('866049074634379');
      expect(frame).not.toContain('org-b');
    } finally {
      await reader.cancel();
    }
  });
});
