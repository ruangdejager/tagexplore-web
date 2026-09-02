import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuthUser } from '@tagexplore/core';
import { loadConfig, type Config } from '../src/config.js';
import { Store } from '../src/db/index.js';
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
    expect(me.user).toMatchObject({ username: 'shepherd', role: 'user', orgId: null });
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

  it('scopes a user to their own organisation and ignores an orgId they ask for', async () => {
    const userCookie = await signup('shepherd');
    store.createOrg('org-a', 'Org A');
    store.createOrg('org-b', 'Org B');
    store.setUserOrg(store.getUserByUsername('shepherd')!.id, 'org-a');
    store.addOrgTags('org-a', ['3E1E']);
    store.addOrgTags('org-b', ['441F']);

    const own = (await (await get('/api/tags', userCookie)).json()) as { tags: Array<{ tagId: string }> };
    expect(own.tags.map((t) => t.tagId)).toEqual(['3E1E']);

    // Asking for someone else's organisation gets their own back, not a leak.
    const other = (await (await get('/api/tags?orgId=org-b', userCookie)).json()) as { tags: Array<{ tagId: string }> };
    expect(other.tags.map((t) => t.tagId)).toEqual(['3E1E']);
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
    const res = await app.request(`/api/admin/users/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ role: 'user' }),
    });
    expect(res.status).toBe(409);
    expect(store.getUserByUsername('founder')?.role).toBe('admin');
  });
});
