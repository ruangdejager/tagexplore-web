import {
  ALERT_SNAPSHOT_WINDOW_HOURS,
  computeTagAlerts,
  describeTagAlert,
  type TagAlert,
} from '@tagexplore/core';
import type { Config } from '../config.js';
import type { PushSubscriptionRow, Store } from '../db/index.js';
import type { LiveBus } from '../events/bus.js';
import { generateVapidKeys, sendWebPush, type VapidKeys } from './webPush.js';

/**
 * Works out each organisation's alerts on the server and pushes a notification
 * to the phones following it when a tag *enters* an alert.
 *
 * It runs in two situations:
 *   - shortly after new readings land (via the live bus), which is what
 *     catches a tag going still;
 *   - every `alertCheckMinutes` regardless, because "not seen in 8h" is the
 *     absence of data and nothing arrives to announce it.
 *
 * The rule itself is `computeTagAlerts` in core, the same rule the web app's
 * alerts panel and the mobile app's list use.
 */

/** A tag that keeps flipping between moving and still notifies at most this often per alert kind. */
export const ALERT_RENOTIFY_COOLDOWN_MS = 6 * 3_600_000;
/** Readers in the same round post within seconds of each other; this folds them into one check. */
const READINGS_DEBOUNCE_MS = 30_000;
/**
 * The snapshot query's upper bound is pushed past "now" by this much, because
 * a discovery's bracket can be rounded a few minutes into the future. Without
 * it a tag's newest reading could fall outside the window and the tag would
 * look staler than it is.
 */
const FUTURE_SLACK_MS = 3_600_000;

export interface AlertNotifier {
  start(): void;
  stop(): void;
  /** Re-checks one organisation now. Returns what was newly notified (for tests and the log). */
  checkOrg(orgId: string, nowMs?: number): Promise<{ alerts: TagAlert[]; notified: TagAlert[]; sent: number }>;
  /** Sends a one-off test notification to a single subscription. */
  sendTest(sub: PushSubscriptionRow): Promise<{ ok: boolean; status: number }>;
  readonly vapidPublicKey: string;
}

/** The organisation's current alerts, judged over the tags still switched on for it. */
export function currentOrgAlerts(store: Store, orgId: string, nowMs: number): TagAlert[] {
  const hidden = new Set(store.listOrgTags(orgId).filter((t) => t.hidden).map((t) => t.tagId));
  const snapshots = store
    .tagSnapshots({ orgId, from: nowMs - ALERT_SNAPSHOT_WINDOW_HOURS * 3_600_000, to: nowMs + FUTURE_SLACK_MS })
    .filter((s) => !hidden.has(s.tagId));
  return computeTagAlerts(snapshots, nowMs);
}

/**
 * Environment keys win; otherwise the pair stored in the database; otherwise a
 * fresh pair, stored so it survives a restart. Every phone's subscription is
 * bound to the public key, so it must not change between boots.
 */
export function resolveVapidKeys(store: Store, config: Config): VapidKeys {
  if (config.vapidPublicKey && config.vapidPrivateKey) {
    return { publicKey: config.vapidPublicKey, privateKey: config.vapidPrivateKey, subject: config.vapidSubject };
  }
  const stored = store.getSetting('vapidKeys');
  if (stored) {
    const parsed = JSON.parse(stored) as { publicKey: string; privateKey: string };
    return { ...parsed, subject: config.vapidSubject };
  }
  const fresh = generateVapidKeys();
  store.setSetting('vapidKeys', JSON.stringify(fresh));
  console.log('[push] generated a VAPID key pair and stored it in the database');
  return { ...fresh, subject: config.vapidSubject };
}

export type PushSender = typeof sendWebPush;

export function createAlertNotifier(deps: {
  store: Store;
  config: Config;
  bus: LiveBus;
  keys: VapidKeys;
  /** Injectable so tests never reach a real push service. */
  send?: PushSender;
}): AlertNotifier {
  const { store, config, bus, keys } = deps;
  const send = deps.send ?? sendWebPush;

  let timer: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;
  const debounces = new Map<string, ReturnType<typeof setTimeout>>();
  // One check per org at a time: a debounce firing while the periodic check
  // is mid-send would otherwise notify the same alert twice.
  const running = new Map<string, Promise<unknown>>();

  async function deliver(orgId: string, payload: unknown): Promise<number> {
    const subs = store.listPushSubscriptionsForOrg(orgId);
    let sent = 0;
    await Promise.all(
      subs.map(async (sub) => {
        const now = Date.now();
        try {
          const result = await send(sub, payload, keys);
          if (result.gone) {
            store.deletePushSubscription(sub.endpoint);
          } else if (result.status >= 200 && result.status < 300) {
            store.markPushResult(sub.endpoint, now, null);
            sent += 1;
          } else {
            store.markPushResult(sub.endpoint, now, `HTTP ${result.status}`);
            console.warn(`[push] ${new URL(sub.endpoint).host} answered ${result.status}`);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          store.markPushResult(sub.endpoint, now, message);
          console.warn(`[push] send failed: ${message}`);
        }
      }),
    );
    return sent;
  }

  async function runCheck(orgId: string, nowMs: number): Promise<{ alerts: TagAlert[]; notified: TagAlert[]; sent: number }> {
    const alerts = currentOrgAlerts(store, orgId, nowMs);
    const previous = store.listAlertState(orgId);
    const prevByKey = new Map(previous.map((p) => [`${p.tagId}|${p.kind}`, p]));
    const currentKeys = new Set(alerts.map((a) => `${a.tagId}|${a.kind}`));

    const toNotify: TagAlert[] = [];
    for (const alert of alerts) {
      const prev = prevByKey.get(`${alert.tagId}|${alert.kind}`);
      const entering = !prev || !prev.active;
      store.setAlertActive(orgId, alert.tagId, alert.kind, nowMs);
      if (entering && (prev?.lastNotifiedAt == null || nowMs - prev.lastNotifiedAt >= ALERT_RENOTIFY_COOLDOWN_MS)) {
        toNotify.push(alert);
      }
    }
    for (const prev of previous) {
      if (prev.active && !currentKeys.has(`${prev.tagId}|${prev.kind}`)) store.setAlertCleared(orgId, prev.tagId, prev.kind);
    }

    if (toNotify.length === 0) return { alerts, notified: [], sent: 0 };

    // Marked before sending, not after: a failed send is not retried into a
    // duplicate on the next check, and a phone that was offline still gets it
    // later from the push service, which holds it for the TTL.
    for (const a of toNotify) store.markAlertNotified(orgId, a.tagId, a.kind, nowMs);

    const orgName = store.getOrg(orgId)?.name ?? 'TagExplore';
    const name = (a: TagAlert): string => (a.label ? `${a.tagId} ${a.label}` : a.tagId);
    const payload =
      toNotify.length === 1
        ? {
            title: `${orgName}: ${name(toNotify[0]!)}`,
            body: `Tag ${describeTagAlert(toNotify[0]!, nowMs)}`,
            tag: `${orgId}:${toNotify[0]!.tagId}`,
            url: `/m/?org=${encodeURIComponent(orgId)}&tag=${encodeURIComponent(toNotify[0]!.tagId)}`,
            badge: alerts.length,
          }
        : {
            title: `${orgName}: ${toNotify.length} new alerts`,
            body: toNotify
              .slice(0, 6)
              .map((a) => `${name(a)}: ${describeTagAlert(a, nowMs)}`)
              .join('\n') + (toNotify.length > 6 ? `\n+${toNotify.length - 6} more` : ''),
            tag: `${orgId}:batch:${nowMs}`,
            url: `/m/?org=${encodeURIComponent(orgId)}`,
            badge: alerts.length,
          };

    const sent = await deliver(orgId, payload);
    if (sent > 0) console.log(`[push] ${orgName}: ${toNotify.length} new alert(s) sent to ${sent} device(s)`);
    return { alerts, notified: toNotify, sent };
  }

  function checkOrg(orgId: string, nowMs: number = Date.now()): Promise<{ alerts: TagAlert[]; notified: TagAlert[]; sent: number }> {
    const prior = running.get(orgId) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(() => runCheck(orgId, nowMs));
    running.set(orgId, next);
    void next.finally(() => {
      if (running.get(orgId) === next) running.delete(orgId);
    }).catch(() => undefined);
    return next;
  }

  async function checkAll(): Promise<void> {
    for (const org of store.listOrgNames()) {
      try {
        await checkOrg(org.id);
      } catch (err) {
        console.error(`[push] alert check failed for ${org.id}:`, err instanceof Error ? err.message : err);
      }
    }
  }

  return {
    vapidPublicKey: keys.publicKey,

    start(): void {
      if (timer) return;
      unsubscribe = bus.subscribeAll((event) => {
        // Readings change what a tag is doing; a tag being switched on or off
        // changes which tags are watched at all.
        if (event.type !== 'readings' && event.type !== 'tags') return;
        const existing = debounces.get(event.orgId);
        if (existing) clearTimeout(existing);
        const t = setTimeout(() => {
          debounces.delete(event.orgId);
          checkOrg(event.orgId).catch((err) =>
            console.error(`[push] alert check failed for ${event.orgId}:`, err instanceof Error ? err.message : err),
          );
        }, READINGS_DEBOUNCE_MS);
        t.unref();
        debounces.set(event.orgId, t);
      });
      timer = setInterval(() => void checkAll(), config.alertCheckMinutes * 60_000);
      timer.unref();
      // A first pass shortly after boot, so the stored state catches up with
      // whatever happened while the server was down.
      setTimeout(() => void checkAll(), 15_000).unref();
    },

    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
      unsubscribe?.();
      unsubscribe = null;
      for (const t of debounces.values()) clearTimeout(t);
      debounces.clear();
    },

    checkOrg,

    async sendTest(sub: PushSubscriptionRow): Promise<{ ok: boolean; status: number }> {
      const orgName = store.getOrg(sub.orgId)?.name ?? 'TagExplore';
      const result = await send(
        sub,
        {
          title: `${orgName}: test notification`,
          body: 'Alerts for this organisation will arrive like this.',
          tag: `${sub.orgId}:test`,
          url: `/m/?org=${encodeURIComponent(sub.orgId)}`,
          badge: currentOrgAlerts(store, sub.orgId, Date.now()).length,
        },
        keys,
      );
      if (result.gone) store.deletePushSubscription(sub.endpoint);
      else store.markPushResult(sub.endpoint, Date.now(), result.status < 300 ? null : `HTTP ${result.status}`);
      return { ok: result.status >= 200 && result.status < 300, status: result.status };
    },
  };
}
