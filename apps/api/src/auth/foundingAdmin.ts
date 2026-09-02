import { nanoid } from 'nanoid';
import { hashPassword } from './password.js';
import type { Store } from '../db/index.js';

/**
 * Creates the founding admin account if it does not exist yet — the one case
 * `Store`'s own (synchronous, promote-only) bootstrap can't handle, since
 * hashing a password is async. This is what makes a brand-new deployment (an
 * empty database, e.g. a fresh Railway volume) usable without a manual signup
 * step: the account exists and is an admin from the very first boot.
 *
 * Once the account exists, this never touches its password again — only
 * `Store`'s sync bootstrap keeps re-affirming the role on every later boot.
 */
export async function ensureFoundingAdmin(store: Store, username: string, password: string): Promise<void> {
  if (store.getUserByUsername(username)) return;

  const id = nanoid(14);
  store.createUser(id, username, await hashPassword(password));
  store.setUserRole(id, 'admin');
}
