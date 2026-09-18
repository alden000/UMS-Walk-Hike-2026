// Service worker: makes the app usable on the trail, where the reserve has
// patchy mobile coverage.
//
//   app shell + route data  precached, served cache-first
//   map tiles               cached as they are viewed, capped, stale-while-revalidate
//   NEA weather             network-only (the app keeps its own short-lived copy)

const VERSION = 'v10';
const SHELL_CACHE = `ums-shell-${VERSION}`;
const TILE_CACHE = `ums-tiles-${VERSION}`;
const MAX_TILES = 1200;

const SHELL = [
  './',
  'index.html',
  'css/app.css',
  'js/app.js',
  'js/geo.js',
  'js/icons.js',
  'js/weather.js',
  'vendor/leaflet.js',
  'vendor/leaflet.css',
  'vendor/markercluster.js',
  'vendor/markercluster.css',
  'vendor/marker-shadow.png',
  'data/route.json',
  'data/pois.json',
  'data/trails.json',
  'data/checkpoints.json',
  'data/photos.json',
  'photos/cp3.jpg',
  'photos/cp6.jpg',
  'photos/cp11.jpg',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

const TILE_HOSTS = [
  'www.onemap.gov.sg',
  'tile.openstreetmap.org',
  'server.arcgisonline.com',
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // one failing entry must not abort the whole install
    await Promise.all(SHELL.map(url =>
      cache.add(new Request(url, { cache: 'reload' })).catch(err => console.warn('precache', url, err))));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, TILE_CACHE]);
    for (const key of await caches.keys()) {
      if (!keep.has(key)) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // never cache the live weather feed
  if (url.hostname.endsWith('data.gov.sg')) return;

  if (TILE_HOSTS.includes(url.hostname)) {
    event.respondWith(tileFirst(request));
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(shellFirst(request));
  }
});

/** Cache-first for the shell, with a background refresh so updates land. */
async function shellFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(request, { ignoreSearch: true });
  const network = fetch(request)
    .then(res => {
      if (res.ok) cache.put(request, res.clone());
      return res;
    })
    .catch(() => null);

  if (hit) return hit;          // the background refresh above updates the cache
  const res = await network;
  if (res) return res;

  // navigations fall back to the app shell so the PWA still opens offline
  if (request.mode === 'navigate') {
    const shell = await cache.match('index.html');
    if (shell) return shell;
  }
  return new Response('Offline', { status: 503, statusText: 'Offline' });
}

/** Tiles: serve the cached copy if there is one, otherwise fetch and keep it. */
async function tileFirst(request) {
  const cache = await caches.open(TILE_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;

  try {
    const res = await fetch(request);
    // Leaflet requests tiles as plain <img>, so these come back as opaque
    // cross-origin responses: status 0 and `ok` false even when they succeeded.
    // They are still storable and still render, so cache them too.
    if (res.ok || res.type === 'opaque') {
      // a full tile cache must not break tile loading
      cache.put(request, res.clone()).then(() => trimTiles(cache)).catch(() => {});
    }
    return res;
  } catch {
    return new Response('', { status: 504, statusText: 'Tile unavailable' });
  }
}

let trimming = false;
async function trimTiles(cache) {
  if (trimming) return;
  trimming = true;
  try {
    const keys = await cache.keys();
    if (keys.length > MAX_TILES) {
      // oldest first — Cache Storage preserves insertion order
      for (const key of keys.slice(0, keys.length - MAX_TILES)) await cache.delete(key);
    }
  } finally {
    trimming = false;
  }
}
