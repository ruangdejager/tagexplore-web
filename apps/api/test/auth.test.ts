import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuthUser } from '@tagexplore/core';
import { loadConfig, type Config } from '../src/config.js';
import { Store } from '../src/db/index.js';
import { createAccountApi } from '../src/routes/account.js';
import { createAdminApi } from '../src/routes/admin.js';
import { createApi } from '../src/routes/api.js';
import { createAuthApi } from '../src/routes/auth.js';

let dir: string;
let store: Store;
let config: Config;
let app: Hono;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tagexplore-auth-'));
  store = new Store(join(dir, 'test.db'), 'founder');
  config = loadConfig();

  app = new Hono();
  app.route('/api/auth', createAuthApi({ store, cookieSecure: false }));
  app.route('/api/account', createAccountApi({ store }));
  app.route('/api/admin', createAdminApi({ store, config }));
  app.route('/api', createApi({ store, config }));
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
    expect(await res.json()).toEqual({ preferences: { hiddenTagIds: [], colorMode: 'discovery', lastOrgId: null } });
  });

  it('saves this user’s toggles and last-viewed org and hands them back on the next fetch', async () => {
    const cookie = await signup('shepherd');
    const saved = await put(
      '/api/account/preferences',
      { hiddenTagIds: ['3E1E', '441F'], colorMode: 'latestGps', lastOrgId: 'org-a' },
      cookie,
    );
    expect(saved.status).toBe(200);

    const res = await get('/api/account/preferences', cookie);
    expect(await res.json()).toEqual({
      preferences: { hiddenTagIds: ['3E1E', '441F'], colorMode: 'latestGps', lastOrgId: 'org-a' },
    });
  });

  it('keeps each user’s preferences separate from the others', async () => {
    const shepherdCookie = await signup('shepherd');
    const otherCookie = await signup('other');
    await put(
      '/api/account/preferences',
      { hiddenTagIds: ['3E1E'], colorMode: 'age', lastOrgId: 'org-a' },
      shepherdCookie,
    );

    const res = await get('/api/account/preferences', otherCookie);
    expect(await res.json()).toEqual({ preferences: { hiddenTagIds: [], colorMode: 'discovery', lastOrgId: null } });
  });

  it('rejects a malformed body rather than saving it', async () => {
    const cookie = await signup('shepherd');
    const res = await put(
      '/api/account/preferences',
      { hiddenTagIds: 'not-an-array', colorMode: 'age', lastOrgId: null },
      cookie,
    );
    expect(res.status).toBe(400);
  });

  it('requires a session', async () => {
    expect((await get('/api/account/preferences')).status).toBe(401);
  });
});
