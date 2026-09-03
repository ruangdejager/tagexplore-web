import { Hono } from 'hono';
import type { UserPreferences } from '@tagexplore/core';
import { currentUser } from '../auth/session.js';
import type { Store } from '../db/index.js';

const DEFAULT_PREFERENCES: UserPreferences = { hiddenTagIds: [], colorMode: 'discovery', lastOrgId: null };

function isUserPreferences(value: unknown): value is UserPreferences {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    Array.isArray(v['hiddenTagIds']) &&
    v['hiddenTagIds'].every((id) => typeof id === 'string') &&
    (v['colorMode'] === 'age' || v['colorMode'] === 'latestGps' || v['colorMode'] === 'discovery') &&
    (v['lastOrgId'] === null || typeof v['lastOrgId'] === 'string')
  );
}

export interface AccountDeps {
  store: Store;
}

type Env = { Variables: { userId: string } };

/**
 * Routes for a logged-in user who does not necessarily have an organisation
 * yet — deliberately separate from `api.ts`, whose middleware requires one.
 * This is where "which orgs exist to ask for" and "did anyone answer my ask"
 * live.
 */
export function createAccountApi(deps: AccountDeps): Hono<Env> {
  const api = new Hono<Env>();

  api.use('*', async (c, next) => {
    const user = currentUser(c, deps.store);
    if (!user) return c.json({ error: 'Log in first.' }, 401);
    c.set('userId', user.id);
    await next();
  });

  /** Every organisation this user doesn't already belong to — enough to pick one to ask for. */
  api.get('/orgs', (c) => {
    const already = new Set(deps.store.listOrgsForUser(c.get('userId')).map((o) => o.id));
    return c.json({ orgs: deps.store.listOrgNames().filter((o) => !already.has(o.id)) });
  });

  /** This user's most recent request, so a pending ask shows as pending rather than as nothing. */
  api.get('/org-request', (c) => c.json({ request: deps.store.getOrgRequestForUser(c.get('userId')) }));

  api.post('/org-request', async (c) => {
    const userId = c.get('userId');

    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const orgId = typeof body['orgId'] === 'string' ? body['orgId'] : '';
    if (!orgId) return c.json({ error: 'orgId is required.' }, 400);
    if (!deps.store.getOrg(orgId)) return c.json({ error: 'No organisation with that id.' }, 404);
    if (deps.store.userHasOrg(userId, orgId)) return c.json({ error: 'You already belong to that organisation.' }, 409);

    try {
      deps.store.createOrgRequest(userId, orgId);
    } catch {
      // The partial unique index is what actually enforces this; a plain try/catch
      // is simpler here than a pre-check that could itself race with a second tab.
      return c.json({ error: 'You already have a pending request — wait for an admin to answer it.' }, 409);
    }
    return c.json({ request: deps.store.getOrgRequestForUser(userId) }, 201);
  });

  /** The map toggles this user last left behind — falls back to the defaults for a first-ever visit. */
  api.get('/preferences', (c) => {
    const raw = deps.store.getUserPreferences(c.get('userId'));
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return c.json({ preferences: isUserPreferences(parsed) ? parsed : DEFAULT_PREFERENCES });
  });

  api.put('/preferences', async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    if (!isUserPreferences(body)) return c.json({ error: 'Invalid preferences.' }, 400);
    deps.store.setUserPreferences(c.get('userId'), JSON.stringify(body));
    return c.json({ ok: true });
  });

  return api;
}
