// Minimal service worker: makes the app installable. Always goes to the network -
// purchase data must never be served stale from a cache.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => e.respondWith(fetch(e.request)));
