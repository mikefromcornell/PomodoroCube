/* PomodoroCube service worker — offline support with a tiny app shell cache.
   No dependencies, no network calls beyond the site's own files. */
const CACHE = 'pomodorocube-v1';
const SHELL = [
  './',
  './index.html',
  './src/styles.css',
  './src/app.js',
  './manifest.webmanifest',
  './assets/favicon.svg',
  './assets/icon.svg',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/icon-maskable-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL).catch(() => cache.addAll(['./', './index.html'])))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; /* never touch third-party requests */

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) {
      /* refresh in the background, serve instantly from cache (works offline) */
      fetch(req).then((res) => { if (res && res.ok) cache.put(req, res.clone()); }).catch(() => {});
      return cached;
    }
    try {
      const res = await fetch(req);
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    } catch (err) {
      const fallback = await cache.match('./index.html');
      if (fallback) return fallback;
      throw err;
    }
  })());
});
