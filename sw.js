/* TaskFlow Teams service worker: lets the app open offline (view last saved data + Branch Report) */
const CACHE = 'taskflow-v3';
const LOCAL = ['./', 'manifest.json', 'icon-192.png', 'icon-512.png'];
const CDN = [
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.js',
  'https://cdn.jsdelivr.net/npm/@emailjs/browser@4.4.1/dist/email.min.js',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js',
  'https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js'
];
const ALLOW = ['cdn.jsdelivr.net', 'www.gstatic.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];
const NEVER = ['firebaseio.com', 'firebasedatabase.app', 'identitytoolkit.googleapis.com', 'securetoken.googleapis.com', 'api.emailjs.com'];

/* Download a file and everything it imports (JS modules / CSS fonts) into the cache */
async function crawl(cache, url, seen, depth) {
  if (seen.has(url) || depth > 4) return;
  seen.add(url);
  try {
    const res = await fetch(url, { mode: 'cors' });
    if (!res.ok) return;
    await cache.put(url, res.clone());
    const type = res.headers.get('content-type') || '';
    if (/javascript/.test(type) || /\.js(\?|$)/.test(url)) {
      const txt = await res.clone().text();
      const re = /(?:from|import)\s*["']([^"']+)["']/g; let m;
      while ((m = re.exec(txt))) { if (/^(\.|https?:)/.test(m[1])) await crawl(cache, new URL(m[1], url).href, seen, depth + 1); }
    } else if (/css/.test(type)) {
      const txt = await res.clone().text();
      const re = /url\(([^)]+)\)/g; let m;
      while ((m = re.exec(txt))) { const u = m[1].replace(/["']/g, ''); if (/^https?:/.test(u)) await crawl(cache, u, seen, depth + 1); }
    }
  } catch (e) { /* ignore: it will be cached the next time it is requested online */ }
}

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await Promise.all(LOCAL.map(u => c.add(u).catch(() => {})));
    const seen = new Set();
    for (const u of CDN) await crawl(c, u, seen, 0);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

async function navigate(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await Promise.race([fetch(req), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 6000))]);
    if (res && res.ok) { cache.put(req, res.clone()); cache.put('./__shell', res.clone()); }
    return res;
  } catch (err) {
    return (await cache.match(req)) || (await cache.match('./__shell')) || Response.error();
  }
}

async function swr(req) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req);
  const net = fetch(req).then(res => { if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone()); return res; }).catch(() => null);
  return cached || (await net) || Response.error();
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (NEVER.some(h => req.url.includes(h))) return;
  if (req.mode === 'navigate') { e.respondWith(navigate(req)); return; }
  const url = new URL(req.url);
  if (url.origin !== self.location.origin && !ALLOW.includes(url.hostname)) return;
  e.respondWith(swr(req));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then(cs => cs.length ? cs[0].focus() : self.clients.openWindow('./')));
});
