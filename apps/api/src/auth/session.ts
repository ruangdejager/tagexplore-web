import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Context } from 'hono';
import { nanoid } from 'nanoid';
import type { Store, UserRow } from '../db/index.js';

export const SESSION_COOKIE = 'tx_session';
const SESSION_TTL_MS = 30 * 86_400_000; // 30 days

/** Longer than a nanoid record id — this is a bearer credential, not a URL slug. */
const SESSION_ID_LENGTH = 32;

export function startSession(c: Context, store: Store, userId: string, secure: boolean): void {
  const id = nanoid(SESSION_ID_LENGTH);
  store.createSession(id, userId, Date.now() + SESSION_TTL_MS);
  setCookie(c, SESSION_COOKIE, id, {
    httpOnly: true,
    sameSite: 'Lax',
    secure,
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export function endSession(c: Context, store: Store): void {
  const id = getCookie(c, SESSION_COOKIE);
  if (id) store.deleteSession(id);
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}

/** The logged-in user's id, or null if there's no session, an unknown one, or an expired one. */
export function currentUserId(c: Context, store: Store): string | null {
  const id = getCookie(c, SESSION_COOKIE);
  if (!id) return null;

  const session = store.getSession(id);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    store.deleteSession(id);
    return null;
  }
  return session.userId;
}

export function currentUser(c: Context, store: Store): UserRow | null {
  const userId = currentUserId(c, store);
  return userId ? store.getUserById(userId) : null;
}
