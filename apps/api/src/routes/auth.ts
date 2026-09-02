import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import type { AuthUser } from '@tagexplore/core';
import { DUMMY_HASH, hashPassword, verifyPassword } from '../auth/password.js';
import { currentUser, endSession, startSession } from '../auth/session.js';
import type { Store, UserRow } from '../db/index.js';

export interface AuthDeps {
  store: Store;
  /** Only set the cookie's Secure flag once the app is actually served over HTTPS. */
  cookieSecure: boolean;
}

const USERNAME_PATTERN = /^[a-zA-Z0-9_.-]{3,32}$/;
const MIN_PASSWORD_LENGTH = 8;

/**
 * Role and organisation travel with every auth response, so the client can gate
 * the admin UI and scope its first data request without a second round trip.
 */
export function publicUser(store: Store, user: UserRow): AuthUser {
  const org = user.orgId ? store.getOrg(user.orgId) : null;
  return { id: user.id, username: user.username, role: user.role, orgId: org?.id ?? null, orgName: org?.name ?? null };
}

export function createAuthApi(deps: AuthDeps): Hono {
  const auth = new Hono();

  auth.post('/signup', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const username = typeof body['username'] === 'string' ? body['username'].trim() : '';
    const password = typeof body['password'] === 'string' ? body['password'] : '';

    if (!USERNAME_PATTERN.test(username)) {
      return c.json({ error: 'Username must be 3-32 characters: letters, numbers, "_", "." or "-".' }, 400);
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      return c.json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` }, 400);
    }
    if (deps.store.getUserByUsername(username)) {
      return c.json({ error: 'That username is already taken.' }, 409);
    }

    const id = nanoid(14);
    deps.store.createUser(id, username, await hashPassword(password));

    startSession(c, deps.store, id, deps.cookieSecure);
    const user = deps.store.getUserById(id);
    // A new account has no organisation yet, so it sees nothing until an admin
    // places it in one. That is deliberate: signing up is not access.
    return c.json({ user: user ? publicUser(deps.store, user) : null }, 201);
  });

  auth.post('/login', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const username = typeof body['username'] === 'string' ? body['username'].trim() : '';
    const password = typeof body['password'] === 'string' ? body['password'] : '';

    const user = deps.store.getUserByUsername(username);
    // Verify against a hash either way — a real one, or the fixed dummy — so an
    // unknown username costs the same time as a wrong password.
    const ok = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok) {
      return c.json({ error: 'Incorrect username or password.' }, 401);
    }

    startSession(c, deps.store, user.id, deps.cookieSecure);
    return c.json({ user: publicUser(deps.store, user) });
  });

  auth.post('/logout', (c) => {
    endSession(c, deps.store);
    return c.json({ ok: true });
  });

  auth.get('/me', (c) => {
    const user = currentUser(c, deps.store);
    return c.json({ user: user ? publicUser(deps.store, user) : null });
  });

  return auth;
}
