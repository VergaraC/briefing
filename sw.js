// Briefing service worker: keeps the app shell usable offline.
// Strategy: network-first for everything same-origin (so updates arrive immediately),
// falling back to the cached copy when there is no connection. Headlines themselves
// live in localStorage, so an offline open still shows the last refresh.
const CACHE = 'briefing-shell-v3';
const SHELL = ['./', './index.html', './manifest.json', './icon.svg', './icon-180.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Daily digest: the worker's cron sends an empty push; we wake up and show the notification.
self.addEventListener('push', e => {
  e.waitUntil(self.registration.showNotification('Briefing ☕', {
    body: 'Your morning top stories are ready — tap to read.',
    icon: './icon-180.png',
    badge: './icon-180.png',
    tag: 'briefing-digest',
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) if ('focus' in c) return c.focus();
      return clients.openWindow('./');
    })
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // feeds always go to the network
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
