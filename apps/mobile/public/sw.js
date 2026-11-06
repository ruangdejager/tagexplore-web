/*
 * TagExplore phone app service worker. Scope: /m/ only, so it never touches
 * the desktop app at /.
 *
 * Its jobs:
 *   1. Show alert notifications the server pushes (see apps/api/src/push).
 *   2. Open the app at the tag in question when a notification is tapped.
 *   3. Keep a copy of the app shell so the home-screen icon still opens
 *      something sensible with no signal, rather than Safari's error page.
 *
 * Plain JavaScript, not bundled: it is copied to /m/sw.js as is.
 */

const SHELL_CACHE = 'tagexplore-m-shell-v1';
const SHELL_URL = '/m/';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.add(new Request(SHELL_URL, { cache: 'reload' })))
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('tagexplore-m-') && k !== SHELL_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Page loads go to the network first, so a deploy shows up straight away; the
// cached shell is only the fallback when there is no connection. API calls and
// hashed assets are left to the browser's normal handling.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.mode !== 'navigate') return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(SHELL_URL, copy)).catch(() => undefined);
        }
        return res;
      })
      .catch(() => caches.match(SHELL_URL).then((cached) => cached || Response.error())),
  );
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'TagExplore', body: event.data ? event.data.text() : '' };
  }

  const title = data.title || 'TagExplore';
  const options = {
    body: data.body || '',
    tag: data.tag || undefined,
    icon: '/m/icons/icon-192.png',
    badge: '/m/icons/icon-192.png',
    data: { url: data.url || SHELL_URL },
  };

  const tasks = [self.registration.showNotification(title, options)];
  // The home-screen icon's red badge: how many alerts are active right now.
  if (typeof data.badge === 'number' && 'setAppBadge' in self.navigator) {
    tasks.push((data.badge > 0 ? self.navigator.setAppBadge(data.badge) : self.navigator.clearAppBadge()).catch(() => undefined));
  }
  // Tell any open copy of the app to refresh its lists.
  tasks.push(
    self.clients.matchAll({ type: 'window' }).then((clients) => clients.forEach((c) => c.postMessage({ type: 'push' }))),
  );
  event.waitUntil(Promise.all(tasks));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || SHELL_URL, self.location.origin).href;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.startsWith(self.location.origin + '/m/') && 'focus' in client) {
          client.postMessage({ type: 'open', url: target });
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
