import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Password hashing via Node's built-in `scrypt` — no dependency the way
 * bcrypt/argon2 would be, consistent with the rest of this app's "nothing to
 * install beyond Node itself" approach (see `db/index.ts` on `node:sqlite`).
 * scrypt is memory-hard, which is the property that actually matters for
 * resisting GPU-accelerated cracking of a stolen hash.
 *
 * Wrapped by hand rather than `promisify(scrypt)`: promisify only picks up one
 * overload, and the options-object form (needed to set the cost parameter) is
 * not it.
 */
function deriveKey(password: string, salt: Buffer, keyLength: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, options, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

const KEY_LENGTH = 64;
/** scrypt N parameter — memory/CPU cost. 2^15 finishes in tens of ms while
 *  staying expensive to brute-force; higher costs more than it protects here. */
const COST = 2 ** 15;
/**
 * scrypt's actual memory need is `128 * N * r` bytes (r defaults to 8), which
 * at N=2^15 is exactly Node's default 32 MiB `maxmem` cap — landing right on
 * that boundary throws "memory limit exceeded" rather than quietly rounding
 * down. Doubling the cap leaves headroom without raising the cost itself.
 */
const MAX_MEM = 64 * 1024 * 1024;

/** `scrypt:<N>:<salt-hex>:<hash-hex>` — the cost is embedded so it can be
 *  raised later without invalidating hashes made under the old value. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await deriveKey(password, salt, KEY_LENGTH, { N: COST, maxmem: MAX_MEM });
  return `scrypt:${COST}:${salt.toString('hex')}:${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split(':');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;

  const cost = Number(parts[1]);
  const salt = Buffer.from(parts[2] ?? '', 'hex');
  const expected = Buffer.from(parts[3] ?? '', 'hex');
  if (!Number.isFinite(cost) || salt.length === 0 || expected.length === 0) return false;

  const derived = await deriveKey(password, salt, expected.length, { N: cost, maxmem: MAX_MEM });
  // Constant-time compare: a length mismatch would otherwise let response
  // timing leak how much of the hash matched.
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

/**
 * A syntactically valid hash of a password nobody has. Login verifies against
 * this when the username does not exist, so a wrong username does not return
 * measurably faster than a wrong password — that timing difference is exactly
 * what lets an attacker enumerate which usernames exist.
 */
export const DUMMY_HASH =
  'scrypt:32768:00000000000000000000000000000000:' + '0'.repeat(128);
