const CACHE = 'opendraw-shell-v54';
const SHELL = ['/', '/app.css?v=54', '/app.js?v=54', '/voice-text.js?v=54', '/chat-ui.js?v=54', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
    .then(() => self.clients.claim()));
});

function shellKey(request) {
  const url = new URL(request.url);
  const relative = `${url.pathname}${url.search}`;
  return SHELL.includes(relative) ? relative : null;
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  const key = shellKey(event.request);
  if (!key) return;

  // The installed SW cache is itself revisioned and its install step fetched this exact
  // HTML + asset set together. Serve that coherent shell directly on warm opens. Release
  // discovery remains explicit in app.js via registration.update(), whose controllerchange
  // reload moves the page to the newly installed revision as one unit.
  event.respondWith(caches.open(CACHE).then(async (cache) => {
    const cached = await cache.match(event.request);
    if (cached) return cached;
    const response = await fetch(event.request, { cache: 'no-store' });
    if (response.ok) void cache.put(event.request, response.clone());
    return response;
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification?.data?.url || '/';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (windows) => {
    const existing = windows.find((client) => new URL(client.url).origin === self.location.origin);
    if (existing) {
      if ('navigate' in existing && !existing.url.endsWith(target)) await existing.navigate(target).catch(() => undefined);
      return existing.focus();
    }
    return self.clients.openWindow(target);
  }));
});

self.addEventListener('push', (event) => {
  // Push payloads intentionally contain no conversation text, session IDs or
  // bearer credentials. The service worker renders fixed privacy-safe copy.
  event.waitUntil(self.registration.showNotification('OpenDraw · Answer ready', {
    body: 'Chat On Steroids finished its response.',
    tag: 'opendraw-answer-ready',
    renotify: true,
    icon: '/icon.svg',
    badge: '/icon.svg',
    data: { url: '/' }
  }));
});
