import { Hono } from 'hono';
import { currentUser } from '../auth/session.js';
import type { Store, UserRow } from '../db/index.js';
import { currentOrgAlerts, type AlertNotifier } from '../push/alertNotifier.js';

/**
 * The mobile app's own surface: switching alert notifications on and off for
 * one phone, and the organisation's current alerts worked out on the server
 * (the same list the notifications are sent from).
 *
 * Mounted at `/api/push`, before the catch-all `/api` router.
 */

export interface PushDeps {
  store: Store;
  notifier: AlertNotifier;
}

type Env = { Variables: { user: UserRow } };

/**
 * Hosts of the browser push services. A subscription endpoint is a URL the
 * server will POST to, so anything else is refused rather than letting a
 * logged-in user point the server at an arbitrary address.
 */
const PUSH_SERVICE_HOSTS = [
  /(^|\.)push\.apple\.com$/,
  /^fcm\.googleapis\.com$/,
  /^android\.googleapis\.com$/,
  /(^|\.)push\.services\.mozilla\.com$/,
  /(^|\.)notify\.windows\.com$/,
];

export function isAllowedPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && PUSH_SERVICE_HOSTS.some((re) => re.test(url.hostname));
}

function canSeeOrg(store: Store, user: UserRow, orgId: string): boolean {
  if (user.role === 'admin') return store.getOrg(orgId) !== null;
  return store.userHasOrg(user.id, orgId);
}

const isB64url = (v: unknown, minLen: number): v is string =>
  typeof v === 'string' && v.length >= minLen && v.length <= 200 && /^[A-Za-z0-9_-]+=*$/.test(v);

export function createPushApi(deps: PushDeps): Hono<Env> {
  const api = new Hono<Env>();

  api.use('*', async (c, next) => {
    const user = currentUser(c, deps.store);
    if (!user) return c.json({ error: 'Log in first.' }, 401);
    c.set('user', user);
    await next();
  });

  /** The public half of the VAPID pair — the browser needs it to subscribe. */
  api.get('/config', (c) => c.json({ publicKey: deps.notifier.vapidPublicKey }));

  /** Whether this phone's subscription is known here, and which organisation it follows. */
  api.post('/status', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const endpoint = body['endpoint'];
    if (typeof endpoint !== 'string') return c.json({ subscribed: false, orgId: null });
    const sub = deps.store.getPushSubscription(endpoint);
    if (!sub || sub.userId !== c.get('user').id) return c.json({ subscribed: false, orgId: null });
    return c.json({ subscribed: true, orgId: sub.orgId });
  });

  api.post('/subscribe', async (c) => {
    const user = c.get('user');
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const orgId = body['orgId'];
    const sub = body['subscription'] as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | undefined;

    if (typeof orgId !== 'string' || !canSeeOrg(deps.store, user, orgId)) {
      return c.json({ error: 'You cannot follow that organisation.' }, 403);
    }
    if (!sub || typeof sub.endpoint !== 'string' || !isAllowedPushEndpoint(sub.endpoint)) {
      return c.json({ error: 'That is not a browser push subscription.' }, 400);
    }
    if (!isB64url(sub.keys?.p256dh, 80) || !isB64url(sub.keys?.auth, 16)) {
      return c.json({ error: 'The subscription keys are missing or malformed.' }, 400);
    }

    deps.store.upsertPushSubscription({
      endpoint: sub.endpoint,
      userId: user.id,
      orgId,
      p256dh: sub.keys.p256dh,
      auth: sub.keys.auth,
      userAgent: c.req.header('user-agent')?.slice(0, 300) ?? null,
      now: Date.now(),
    });
    return c.json({ subscribed: true, orgId });
  });

  api.post('/unsubscribe', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const endpoint = body['endpoint'];
    if (typeof endpoint === 'string') {
      const sub = deps.store.getPushSubscription(endpoint);
      if (sub && sub.userId === c.get('user').id) deps.store.deletePushSubscription(endpoint);
    }
    return c.json({ subscribed: false });
  });

  /** Sends one notification straight away, so the phone owner can see it works. */
  api.post('/test', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const endpoint = body['endpoint'];
    const sub = typeof endpoint === 'string' ? deps.store.getPushSubscription(endpoint) : null;
    if (!sub || sub.userId !== c.get('user').id) return c.json({ error: 'Notifications are not switched on for this phone.' }, 404);
    try {
      const result = await deps.notifier.sendTest(sub);
      if (!result.ok) return c.json({ error: `The push service refused it (HTTP ${result.status}).` }, 502);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Sending failed.' }, 502);
    }
  });

  /** The organisation's current alerts, exactly as the notifier judges them. */
  api.get('/alerts', (c) => {
    const orgId = c.req.query('orgId');
    if (!orgId || !canSeeOrg(deps.store, c.get('user'), orgId)) {
      return c.json({ error: 'You are not a member of that organisation.' }, 403);
    }
    const now = Date.now();
    return c.json({ now, alerts: currentOrgAlerts(deps.store, orgId, now) });
  });

  return api;
}
