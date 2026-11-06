import { createCipheriv, createECDH, createHmac, createPrivateKey, randomBytes, sign } from 'node:crypto';

/**
 * Web Push, written directly against `node:crypto` rather than pulled in as
 * the `web-push` package.
 *
 * The server bundles every dependency into one ESM file (see tsup.config.ts),
 * and `web-push` is CommonJS that `require`s Node builtins at runtime, which
 * an ESM bundle cannot do. The protocol itself is small and fixed:
 *
 *   - VAPID (RFC 8292): an ES256 JWT naming the push service's origin, signed
 *     with our key pair, so the push service knows who is sending.
 *   - Message encryption (RFC 8291, `aes128gcm` from RFC 8188): the payload is
 *     encrypted to the browser's own key, so the push service only ever relays
 *     ciphertext.
 *
 * Apple's push service (web.push.apple.com), Google's (fcm.googleapis.com) and
 * Mozilla's all accept exactly this.
 */

export interface VapidKeys {
  /** Uncompressed P-256 public point, 65 bytes, base64url. Given to the browser as `applicationServerKey`. */
  publicKey: string;
  /** The 32-byte private scalar, base64url. */
  privateKey: string;
  /** A `mailto:` or `https:` contact for the push service operator. */
  subject: string;
}

export interface PushSubscriptionKeys {
  endpoint: string;
  /** The browser's P-256 public key, base64url. */
  p256dh: string;
  /** The browser's 16-byte auth secret, base64url. */
  auth: string;
}

export interface PushResult {
  status: number;
  /** True when the push service says this subscription no longer exists (404/410), so it should be deleted. */
  gone: boolean;
}

const b64url = (buf: Buffer): string => buf.toString('base64url');
const fromB64url = (s: string): Buffer => Buffer.from(s, 'base64url');

/** Fresh VAPID key pair. Run once and keep the result in environment variables. */
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64url(ecdh.getPublicKey()), privateKey: b64url(ecdh.getPrivateKey()) };
}

/** The `Authorization` header value for one push service origin. */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, nowMs: number = Date.now()): string {
  const pub = fromB64url(keys.publicKey);
  if (pub.length !== 65 || pub[0] !== 0x04) throw new Error('VAPID public key must be an uncompressed P-256 point.');
  const key = createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: b64url(pub.subarray(1, 33)),
      y: b64url(pub.subarray(33, 65)),
      d: keys.privateKey,
    },
    format: 'jwk',
  });

  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(
    Buffer.from(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        // 12 hours: comfortably inside the 24-hour ceiling every push service enforces.
        exp: Math.floor(nowMs / 1000) + 12 * 3600,
        sub: keys.subject,
      }),
    ),
  );
  const signingInput = `${header}.${claims}`;
  const signature = sign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${signingInput}.${b64url(signature)}, k=${keys.publicKey}`;
}

function hmac(key: Buffer, data: Buffer): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

/**
 * Encrypts `payload` for one subscription (RFC 8291). Returns the complete
 * request body: the RFC 8188 header (salt, record size, our ephemeral public
 * key) followed by the single encrypted record.
 *
 * `salt` and `ephemeral` are injectable only so a test can pin them.
 */
export function encryptPayload(
  payload: Buffer,
  sub: Pick<PushSubscriptionKeys, 'p256dh' | 'auth'>,
  opts: { salt?: Buffer; ephemeral?: ReturnType<typeof createECDH> } = {},
): Buffer {
  const uaPublic = fromB64url(sub.p256dh);
  const authSecret = fromB64url(sub.auth);
  if (uaPublic.length !== 65) throw new Error('Subscription p256dh must be a 65-byte P-256 point.');
  if (authSecret.length < 16) throw new Error('Subscription auth secret is too short.');

  const ephemeral = opts.ephemeral ?? createECDH('prime256v1');
  if (!opts.ephemeral) ephemeral.generateKeys();
  const asPublic = ephemeral.getPublicKey();
  const ecdhSecret = ephemeral.computeSecret(uaPublic);

  // IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info\0" || ua_public || as_public, 32)
  const prkKey = hmac(authSecret, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]);
  const ikm = hmac(prkKey, keyInfo).subarray(0, 32);

  const salt = opts.salt ?? randomBytes(16);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);

  // A single record: the payload, then the 0x02 "last record" delimiter.
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);

  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(4096);
  return Buffer.concat([salt, recordSize, Buffer.from([asPublic.length]), asPublic, ciphertext]);
}

/** Sends one encrypted notification. Never throws for an HTTP error status; the caller decides what to do. */
export async function sendWebPush(
  sub: PushSubscriptionKeys,
  payload: unknown,
  keys: VapidKeys,
  opts: { ttlSeconds?: number; urgency?: 'very-low' | 'low' | 'normal' | 'high'; timeoutMs?: number; topic?: string } = {},
): Promise<PushResult> {
  const body = encryptPayload(Buffer.from(JSON.stringify(payload)), sub);
  const headers: Record<string, string> = {
    Authorization: vapidAuthorization(sub.endpoint, keys),
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    TTL: String(opts.ttlSeconds ?? 86_400),
    Urgency: opts.urgency ?? 'high',
  };
  // A topic replaces an undelivered message with the same topic, so a phone
  // that was off all night gets one notification per tag, not a pile.
  if (opts.topic) headers['Topic'] = opts.topic;

  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
  });
  // Drain the body so the connection can be reused.
  await res.arrayBuffer().catch(() => undefined);
  return { status: res.status, gone: res.status === 404 || res.status === 410 };
}
