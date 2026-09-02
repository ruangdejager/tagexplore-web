import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureFoundingAdmin } from '../src/auth/foundingAdmin.js';
import { verifyPassword } from '../src/auth/password.js';
import { Store } from '../src/db/index.js';

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tagexplore-founding-admin-'));
  // A username that doesn't match the account this test creates, so Store's
  // own sync bootstrap never fires and only ensureFoundingAdmin is under test.
  store = new Store(join(dir, 'test.db'), 'nobody');
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('ensureFoundingAdmin', () => {
  it('creates the account as an admin on a database where it does not exist', async () => {
    await ensureFoundingAdmin(store, 'ruandj', 'Rdj@5046');

    const user = store.getUserByUsername('ruandj');
    expect(user?.role).toBe('admin');
    expect(await verifyPassword('Rdj@5046', user!.passwordHash)).toBe(true);
  });

  it('never touches the password of an account that already exists', async () => {
    // Simulates a real signup that happened before this ever ran.
    await ensureFoundingAdmin(store, 'ruandj', 'first-password-123');
    const before = store.getUserByUsername('ruandj')?.passwordHash;

    await ensureFoundingAdmin(store, 'ruandj', 'a-completely-different-password');
    const after = store.getUserByUsername('ruandj')?.passwordHash;

    expect(after).toBe(before);
  });
});
