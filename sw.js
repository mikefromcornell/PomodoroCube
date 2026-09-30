/* PomodoroCube service worker — offline support with a tiny app shell cache.
   No dependencies, no network calls beyond the site's own files.

   Strategy: NETWORK-FIRST. A timer must run the code that was actually
   released, so every online load revalidates the real files with the server
   (a cheap 304 when nothing changed) and the cache is only a fallback for when
   the network is down. Serving the cache first — as 1.0.0/1.0.1 did — kept
   returning visitors on the previous release, which hid bug fixes.

   Bump VERSION with every release: tools/check.mjs fails CI if it does not
   match package.json, and a changed sw.js is what makes browsers install the
   new worker (which precaches the new release and drops the old cache). */
const VERSION = '1.0.2';
const PREFIX = 'pomodorocube-';
const CACHE = PREFIX + VERSION;
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

/* cache:'reload' skips the browser's HTTP cache (GitHub Pages sends
   max-age=600), so a new release is never precached with the old files. */
const fresh = (url) => new Request(url, { cache: 'reload' });

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    try {
      await cache.addAll(SHELL.map(fresh));
    } catch (_) {
      await cache.addAll(['./', './index.html'].map(fresh)).catch(() => {});
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    /* Delete only OUR old caches: every <user>.github.io project site shares
       this origin, so "delete everything that isn't mine" would wipe other
       projects' offline copies. */
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((k) => k.startsWith(PREFIX) && k !== CACHE)
      .map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; /* never touch third-party requests */
  event.respondWith(networkFirst(event, req));
});

async function networkFirst(event, req) {
  try {
    /* 'no-cache' = always revalidate with the server, never trust a stale copy. */
    const res = await fetch(new Request(req, { cache: 'no-cache' }));
    if (res && res.ok && res.type === 'basic') {
      const copy = res.clone();
      event.waitUntil(caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {}));
    }
    return res;
  } catch (err) {
    /* offline: fall back to the cached release */
    const cache = await caches.open(CACHE);
    const hit = (await cache.match(req, { ignoreSearch: true })) ||
      (req.mode === 'navigate' ? await cache.match('./index.html') : undefined);
    if (hit) return hit;
    throw err;
  }
}
