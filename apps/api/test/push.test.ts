import { createDecipheriv, createECDH, createHmac, createPublicKey, randomBytes, verify } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeTagAlerts, type TagSnapshot } from '@tagexplore/core';
import { loadConfig } from '../src/config.js';
import { Store, type ReadingInput } from '../src/db/index.js';
import { createLiveBus } from '../src/events/bus.js';
import { ALERT_RENOTIFY_COOLDOWN_MS, createAlertNotifier, type PushSender } from '../src/push/alertNotifier.js';
import { encryptPayload, generateVapidKeys, vapidAuthorization } from '../src/push/webPush.js';
import { createPushApi, isAllowedPushEndpoint } from '../src/routes/push.js';

const HOUR = 3_600_000;
const T0 = Date.parse('2026-08-28T10:00:00Z');

const hmac = (key: Buffer, data: Buffer): Buffer => createHmac('sha256', key).update(data).digest();

/** What the phone's browser does with a push body: RFC 8291 decryption from the receiving side. */
function decryptAsBrowser(body: Buffer, ua: ReturnType<typeof createECDH>, authSecret: Buffer): string {
  const salt = body.subarray(0, 16);
  const idLen = body[20]!;
  const asPublic = body.subarray(21, 21 + idLen);
  const ciphertext = body.subarray(21 + idLen);

  const ecdhSecret = ua.computeSecret(asPublic);
  const prkKey = hmac(authSecret, ecdhSecret);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic, Buffer.from([1])])).subarray(0, 32);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);

  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const plain = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
  expect(plain[plain.length - 1]).toBe(2); // last-record delimiter
  return plain.subarray(0, plain.length - 1).toString('utf8');
}

describe('web push encryption', () => {
  it('produces a body the subscribing browser can decrypt', () => {
    const ua = createECDH('prime256v1');
    ua.generateKeys();
    const auth = randomBytes(16);
    const body = encryptPayload(Buffer.from('{"title":"hello"}'), {
      p256dh: ua.getPublicKey().toString('base64url'),
      auth: auth.toString('base64url'),
    });
    expect(body.readUInt32BE(16)).toBe(4096);
    expect(decryptAsBrowser(body, ua, auth)).toBe('{"title":"hello"}');
  });

  it('signs a VAPID token the public key verifies, scoped to the push service origin', () => {
    const pair = generateVapidKeys();
    const header = vapidAuthorization('https://web.push.apple.com/abc123', { ...pair, subject: 'mailto:a@b.c' }, T0);
    const match = /^vapid t=([^,]+), k=(.+)$/.exec(header);
    expect(match).not.toBeNull();
    const [h, p, sig] = match![1]!.split('.') as [string, string, string];
    expect(match![2]).toBe(pair.publicKey);

    const claims = JSON.parse(Buffer.from(p, 'base64url').toString()) as { aud: string; exp: number; sub: string };
    expect(claims.aud).toBe('https://web.push.apple.com');
    expect(claims.sub).toBe('mailto:a@b.c');
    expect(claims.exp).toBe(Math.floor(T0 / 1000) + 12 * 3600);

    const pub = Buffer.from(pair.publicKey, 'base64url');
    const key = createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') },
      format: 'jwk',
    });
    const ok = verify('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'));
    expect(ok).toBe(true);
  });
});

describe('computeTagAlerts', () => {
  const snap = (partial: Partial<TagSnapshot>): TagSnapshot => ({
    tagId: 'AAAA',
    label: null,
    lastSeenAt: T0,
    batteryMv: 3900,
    rssi: null,
    hops: null,
    waveCount: null,
    movementState: 0,
    fwVersionPatch: null,
    linkId: null,
    sourceDeviceImei: '1',
    lat: null,
    lon: null,
    fixAt: null,
    gpsAgeSeconds: null,
    readingCount: 1,
    stillSince: null,
    ...partial,
  });

  it('flags still tags, and stale ones only when they are not still', () => {
    const alerts = computeTagAlerts(
      [
        snap({ tagId: 'MOVE' }),
        snap({ tagId: 'STIL', movementState: 1, fixAt: T0, stillSince: T0 - HOUR }),
        snap({ tagId: 'OLD1', lastSeenAt: T0 - 9 * HOUR }),
        snap({ tagId: 'OLD2', lastSeenAt: T0 - 9 * HOUR, movementState: 1 }),
      ],
      T0,
    );
    expect(alerts.map((a) => [a.tagId, a.kind])).toEqual([
      ['STIL', 'still'],
      ['OLD1', 'stale'],
      ['OLD2', 'still'],
    ]);
    expect(alerts[0]!.fixAfterStill).toBe(T0);
  });
});

describe('alert notifier', () => {
  const ORG = 'org-a';
  const DEVICE = '866049074634379';
  let dir: string;
  let store: Store;
  let sent: Array<{ endpoint: string; payload: { title: string; body: string } }>;
  let nextStatus: number;

  const fakeSend: PushSender = async (sub, payload) => {
    sent.push({ endpoint: sub.endpoint, payload: payload as { title: string; body: string } });
    return { status: nextStatus, gone: nextStatus === 404 || nextStatus === 410 };
  };

  function reading(tagId: string, bracketAt: number, movementState: number): ReadingInput {
    return {
      deviceImei: DEVICE,
      bracketAt,
      tagId,
      batteryMv: 3900,
      rssi: -60,
      hops: 1,
      waveCount: 1,
      movementState,
      lat: null,
      lon: null,
      hasGps: false,
      fwPatch: 3,
      gpsAgeSeconds: null,
      linkId: null,
      source: 'log',
    };
  }

  function notifier() {
    const keys = { ...generateVapidKeys(), subject: 'mailto:a@b.c' };
    return createAlertNotifier({ store, config: loadConfig(), bus: createLiveBus(), keys, send: fakeSend });
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tagexplore-push-'));
    store = new Store(join(dir, 'test.db'), 'nobody');
    store.createOrg(ORG, 'Farm A');
    store.createDevice(DEVICE, ORG, 'Reader');
    store.createUser('u1', 'pat', 'x');
    store.addUserOrg('u1', ORG);
    store.addOrgTags(ORG, ['AAAA', 'BBBB']);
    store.upsertPushSubscription({
      endpoint: 'https://web.push.apple.com/one',
      userId: 'u1',
      orgId: ORG,
      p256dh: 'x',
      auth: 'y',
      userAgent: null,
      now: T0,
    });
    sent = [];
    nextStatus = 201;
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('notifies once when a tag goes still, not on every later check', async () => {
    const n = notifier();
    store.writeReadings([reading('AAAA', T0, 0), reading('BBBB', T0, 0)], []);
    expect((await n.checkOrg(ORG, T0)).notified).toEqual([]);

    store.writeReadings([reading('AAAA', T0 + HOUR, 1)], []);
    const first = await n.checkOrg(ORG, T0 + HOUR);
    expect(first.notified.map((a) => a.tagId)).toEqual(['AAAA']);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload.title).toBe('Farm A: AAAA');
    expect(sent[0]!.payload.body).toBe('Tag still · No fix');

    await n.checkOrg(ORG, T0 + HOUR + 60_000);
    expect(sent).toHaveLength(1);
  });

  it('does not re-notify a tag flapping between moving and still inside the cooldown', async () => {
    const n = notifier();
    store.writeReadings([reading('AAAA', T0, 1)], []);
    await n.checkOrg(ORG, T0);
    store.writeReadings([reading('AAAA', T0 + HOUR, 0)], []);
    await n.checkOrg(ORG, T0 + HOUR);
    store.writeReadings([reading('AAAA', T0 + 2 * HOUR, 1)], []);
    await n.checkOrg(ORG, T0 + 2 * HOUR);
    expect(sent).toHaveLength(1);

    const later = T0 + 2 * HOUR + ALERT_RENOTIFY_COOLDOWN_MS;
    store.writeReadings([reading('AAAA', later - HOUR, 0)], []);
    await n.checkOrg(ORG, later - HOUR);
    store.writeReadings([reading('AAAA', later, 1)], []);
    await n.checkOrg(ORG, later);
    expect(sent).toHaveLength(2);
  });

  it('notifies a tag that has gone quiet, and skips tags switched off for the org', async () => {
    const n = notifier();
    store.writeReadings([reading('AAAA', T0, 0), reading('BBBB', T0, 0)], []);
    await n.checkOrg(ORG, T0);
    store.setOrgTagHidden(ORG, 'BBBB', true);

    const result = await n.checkOrg(ORG, T0 + 9 * HOUR);
    expect(result.notified.map((a) => [a.tagId, a.kind])).toEqual([['AAAA', 'stale']]);
    expect(sent[0]!.payload.body).toBe('Tag not seen in 9h');
  });

  it('folds several new alerts into one notification', async () => {
    const n = notifier();
    store.writeReadings([reading('AAAA', T0, 1), reading('BBBB', T0, 1)], []);
    await n.checkOrg(ORG, T0);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload.title).toBe('Farm A: 2 new alerts');
  });

  it('works out when a tag went still, and whether a fix came in after', async () => {
    const withFix = (r: ReadingInput): ReadingInput => ({ ...r, hasGps: true, lat: -33.9, lon: 18.8 });
    // Moving with a fix, then two still rounds with none.
    store.writeReadings(
      [withFix(reading('AAAA', T0, 0)), reading('AAAA', T0 + HOUR, 1), reading('AAAA', T0 + 2 * HOUR, 1)],
      [],
    );
    const window = { orgId: ORG, from: T0 - HOUR, to: T0 + 3 * HOUR };
    let snap = store.tagSnapshots(window).find((s) => s.tagId === 'AAAA')!;
    expect(snap.stillSince).toBe(T0 + HOUR);
    expect(snap.fixAt).toBe(T0);

    const first = await notifier().checkOrg(ORG, T0 + 2 * HOUR);
    expect(first.notified[0]!.fixAfterStill).toBeNull();
    expect(sent[0]!.payload.body).toBe('Tag still · No fix');

    // A later still round brings a fix: that one is after it went still.
    store.writeReadings([withFix(reading('AAAA', T0 + 3 * HOUR, 1))], []);
    snap = store.tagSnapshots({ ...window, to: T0 + 4 * HOUR }).find((s) => s.tagId === 'AAAA')!;
    expect(snap.stillSince).toBe(T0 + HOUR);
    const alert = computeTagAlerts([snap], T0 + 3 * HOUR)[0]!;
    expect(alert.fixAfterStill).toBe(T0 + 3 * HOUR);

    // Moving again ends the streak.
    store.writeReadings([reading('AAAA', T0 + 4 * HOUR, 0)], []);
    snap = store.tagSnapshots({ ...window, to: T0 + 5 * HOUR }).find((s) => s.tagId === 'AAAA')!;
    expect(snap.stillSince).toBeNull();
  });

  it('drops a subscription the push service says is gone', async () => {
    const n = notifier();
    nextStatus = 410;
    store.writeReadings([reading('AAAA', T0, 1)], []);
    await n.checkOrg(ORG, T0);
    expect(store.getPushSubscription('https://web.push.apple.com/one')).toBeNull();
  });

  it('stops sending to someone removed from the organisation', async () => {
    const n = notifier();
    store.removeUserOrg('u1', ORG);
    store.writeReadings([reading('AAAA', T0, 1)], []);
    const result = await n.checkOrg(ORG, T0);
    expect(result.notified).toHaveLength(1);
    expect(sent).toHaveLength(0);
  });
});

describe('push routes', () => {
  let dir: string;
  let store: Store;
  let app: Hono;
  const cookie = 'tx_session=session-1';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tagexplore-pushapi-'));
    store = new Store(join(dir, 'test.db'), 'nobody');
    store.createOrg('org-a', 'Farm A');
    store.createOrg('org-b', 'Farm B');
    store.createUser('u1', 'pat', 'x');
    store.addUserOrg('u1', 'org-a');
    store.createSession('session-1', 'u1', Date.now() + HOUR);
    const keys = { ...generateVapidKeys(), subject: 'mailto:a@b.c' };
    const notifier = createAlertNotifier({ store, config: loadConfig(), bus: createLiveBus(), keys });
    app = new Hono();
    app.route('/api/push', createPushApi({ store, notifier }));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const post = (path: string, body: unknown, withCookie = true): Promise<Response> =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(withCookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });

  const ua = createECDH('prime256v1');
  ua.generateKeys();
  const subscription = (endpoint: string) => ({
    endpoint,
    keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') },
  });

  it('only accepts real push service endpoints', () => {
    expect(isAllowedPushEndpoint('https://web.push.apple.com/QW')).toBe(true);
    expect(isAllowedPushEndpoint('https://fcm.googleapis.com/fcm/send/x')).toBe(true);
    expect(isAllowedPushEndpoint('https://evil.example.com/push.apple.com')).toBe(false);
    expect(isAllowedPushEndpoint('http://web.push.apple.com/x')).toBe(false);
  });

  it('subscribes a member, refuses other orgs, bad endpoints and anonymous callers', async () => {
    expect((await post('/api/push/subscribe', { orgId: 'org-a', subscription: subscription('https://web.push.apple.com/a') }, false)).status).toBe(401);
    expect((await post('/api/push/subscribe', { orgId: 'org-b', subscription: subscription('https://web.push.apple.com/a') })).status).toBe(403);
    expect((await post('/api/push/subscribe', { orgId: 'org-a', subscription: subscription('https://example.com/a') })).status).toBe(400);

    const ok = await post('/api/push/subscribe', { orgId: 'org-a', subscription: subscription('https://web.push.apple.com/a') });
    expect(ok.status).toBe(200);
    const status = await post('/api/push/status', { endpoint: 'https://web.push.apple.com/a' });
    expect(await status.json()).toEqual({ subscribed: true, orgId: 'org-a' });

    await post('/api/push/unsubscribe', { endpoint: 'https://web.push.apple.com/a' });
    expect(store.getPushSubscription('https://web.push.apple.com/a')).toBeNull();
  });

  it('serves the current alerts only to members', async () => {
    const res = await app.request('/api/push/alerts?orgId=org-a', { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { alerts: unknown[] }).alerts).toEqual([]);
    expect((await app.request('/api/push/alerts?orgId=org-b', { headers: { cookie } })).status).toBe(403);
  });
});
