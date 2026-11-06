import * as api from './api.js';

/**
 * Installing and notifications, with the iPhone's rules spelled out:
 *
 *   - iOS only allows Web Push for a page added to the Home Screen (iOS 16.4+).
 *     In a Safari tab, `PushManager` is simply missing.
 *   - The permission prompt may only be raised from a tap, never on load.
 *   - There is no install prompt event on iOS; the user adds the app from the
 *     Share sheet themselves, so the app shows how.
 */

export type PushSupport =
  | 'supported'
  /** iPhone/iPad in a Safari tab: needs Add to Home Screen first. */
  | 'needs-install'
  /** Browser has no Web Push at all (old iOS, in-app browsers). */
  | 'unsupported'
  /** Push needs HTTPS (or localhost). */
  | 'insecure';

export function isIos(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function pushSupport(): PushSupport {
  if (!window.isSecureContext) return 'insecure';
  const hasPush = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (hasPush) return 'supported';
  if (isIos() && !isStandalone()) return 'needs-install';
  return 'unsupported';
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return null;
  try {
    return await navigator.serviceWorker.register('/m/sw.js', { scope: '/m/' });
  } catch (err) {
    console.warn('Service worker registration failed:', err);
    return null;
  }
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const reg = (await navigator.serviceWorker.getRegistration('/m/')) ?? (await registerServiceWorker());
  if (!reg) throw new Error('Could not start the background worker notifications need.');
  return navigator.serviceWorker.ready.then(() => reg);
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export interface PushState {
  /** This phone has a live subscription the server knows about. */
  subscribed: boolean;
  /** Which organisation that subscription follows. */
  orgId: string | null;
  permission: NotificationPermission;
  endpoint: string | null;
}

export async function readPushState(): Promise<PushState> {
  const permission = 'Notification' in window ? Notification.permission : 'denied';
  if (pushSupport() !== 'supported') return { subscribed: false, orgId: null, permission, endpoint: null };
  const reg = await navigator.serviceWorker.getRegistration('/m/');
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return { subscribed: false, orgId: null, permission, endpoint: null };
  const status = await api.pushStatus(sub.endpoint).catch(() => ({ subscribed: false, orgId: null }));
  return { ...status, permission, endpoint: sub.endpoint };
}

/** Must be called straight from a tap: iOS refuses the prompt otherwise. */
export async function enablePush(orgId: string): Promise<PushState> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error(
      permission === 'denied'
        ? 'Notifications are blocked. Turn them on in Settings › Notifications › Farmranger Tags.'
        : 'Notifications were not allowed.',
    );
  }
  const reg = await registration();
  const { publicKey } = await api.fetchPushConfig();

  let sub = await reg.pushManager.getSubscription();
  // A subscription made with a different server key can't receive our pushes.
  if (sub) {
    const current = sub.options.applicationServerKey;
    const currentKey = current ? btoa(String.fromCharCode(...new Uint8Array(current))) : '';
    const wantedKey = btoa(String.fromCharCode(...keyBytes(publicKey)));
    if (currentKey !== wantedKey) {
      await sub.unsubscribe();
      sub = null;
    }
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });

  await api.pushSubscribe(orgId, sub.toJSON());
  return { subscribed: true, orgId, permission, endpoint: sub.endpoint };
}

export async function disablePush(): Promise<void> {
  const reg = await navigator.serviceWorker.getRegistration('/m/');
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await api.pushUnsubscribe(sub.endpoint).catch(() => undefined);
  await sub.unsubscribe().catch(() => undefined);
}

/** Keeps the home-screen badge in step with what the app is showing. */
export function setBadge(count: number): void {
  const nav = navigator as Navigator & { setAppBadge?: (n: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
  if (count > 0) nav.setAppBadge?.(count).catch(() => undefined);
  else nav.clearAppBadge?.().catch(() => undefined);
}
