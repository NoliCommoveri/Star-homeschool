// Star Apps service worker — offline caching for the app shell.
// Bump CACHE_VERSION whenever a precached file's content changes so
// clients pick up the new copy instead of a stale cached one.
const CACHE_VERSION = 'v8';
const CACHE_NAME = `star-apps-${CACHE_VERSION}`;

const PRECACHE_URLS = [
  './',
  './index.html',
  './getting-started.html',
  './resources.html',
  './math-star-v6_1.html',
  './spelling-star-v6_3.html',
  './geography-star.html',
  './logic-star.html',
  './parent.html',
  './manifest.json',
  './favicon-32.png',
  './apple-touch-icon.png',
  './icon-192.png',
  './icon-512.png',
  './parent-manifest.json',
  './parent-favicon-32.png',
  './parent-apple-touch-icon.png',
  './parent-icon-192.png',
  './parent-icon-512.png',
  './spelling-lists.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Parent Sync API calls: always network, never cached. These are
  // per-family authenticated reads (children/sessions/devices) — caching
  // them would show stale or, after sign-out/re-pairing on the same device,
  // another family's data.
  if (url.pathname.startsWith('/api/')) return;

  // Pages: try the network first so updates show up right away, but fall
  // back to the cached copy (and cache the fresh response) when offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match(request).then((cached) => cached || caches.match('./index.html')))
    );
    return;
  }

  // Everything else (icons, manifest, word lists): serve from cache first,
  // and refresh the cache in the background so future offline loads stay current.
  event.respondWith(
    caches.match(request).then((cached) => {
      const fetchPromise = fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
