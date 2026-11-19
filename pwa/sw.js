// PadelZit service worker — caches the app shell for offline use.
// Cross-origin requests (e.g. Supabase cloud sync) are never intercepted.
// The deploy workflow replaces __BUILD__ with the commit SHA, so every release
// gets a fresh cache name (and a byte-different worker the browser notices).
const CACHE = 'padelzit-v12-__BUILD__';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
  './icons/icon-180.png',
];

self.addEventListener('install', e => {
  // Don't skipWaiting automatically — the page shows an "update ready" banner
  // and asks this worker to activate only when the user taps Refresh.
  // cache:'reload' bypasses the HTTP cache so a new worker never precaches a stale page.
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))));
});

self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  // Only handle same-origin GETs; let cloud/API and other requests hit the network directly.
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  // App shell / navigations: serve fresh when online, fall back to cache offline.
  // Only the app page itself refreshes the cached shell: r.html, privacy.html
  // or an error page must never be stored as ./index.html. The clone is taken
  // synchronously, before the body is handed to the page.
  if (req.mode === 'navigate') {
    const path = new URL(req.url).pathname;
    const isShell = /\/(index\.html)?$/.test(path);
    e.respondWith(
      fetch(req)
        .then(res => {
          if (isShell && res.ok && res.type === 'basic') {
            const copy = res.clone();
            e.waitUntil(caches.open(CACHE).then(c => c.put('./index.html', copy)));
          }
          return res;
        })
        .catch(() => caches.match(isShell ? './index.html' : req)
          .then(hit => hit || caches.match('./index.html')))
    );
    return;
  }

  // Static assets: cache-first, then network (and cache the result).
  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => hit))
  );
});
