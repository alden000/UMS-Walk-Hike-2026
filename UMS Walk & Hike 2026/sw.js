// Service worker: makes the app usable on the trail, where the reserve has
// patchy mobile coverage.
//
//   app shell + route data  precached, served cache-first
//   map tiles               cached as they are viewed, capped, stale-while-revalidate
//   NEA weather             network-only (the app keeps its own short-lived copy)

const VERSION = 'v24';
const SHELL_CACHE = `ums-shell-${VERSION}`;
const TILE_CACHE = `ums-tiles-${VERSION}`;
const MAX_TILES = 1200;

// Tiles the walker deliberately saved for the trail, kept apart from the ones
// cached in passing. Two reasons: the browsing cache is trimmed oldest-first,
// so a saved map would be the first thing evicted by an afternoon of panning
// about; and the name carries no VERSION, so shipping an app update does not
// throw away a map somebody downloaded on wi-fi the night before.
const OFFLINE_CACHE = 'ums-offline';
// enough parallel requests to keep the link busy without hammering the servers
const SAVE_CONCURRENCY = 6;

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
  'photos/start.jpg',
  'photos/cp1.jpg',
  'photos/cp2.jpg',
  'photos/cp3.jpg',
  'photos/cp4.jpg',
  'photos/cp5.jpg',
  'photos/cp6.jpg',
  'photos/cp7.jpg',
  'photos/cp8.jpg',
  'photos/cp9.jpg',
  'photos/cp10.jpg',
  'photos/cp11.jpg',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
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
    const keep = new Set([SHELL_CACHE, TILE_CACHE, OFFLINE_CACHE]);
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
  // The tile layers set crossOrigin, so tile requests are CORS requests, and an
  // opaque response cannot answer one: the browser rejects it and the tile
  // renders black. A cached opaque tile therefore counts as a miss and is
  // fetched again, rather than being handed back for ever. Every tile cached by
  // a build from before crossOrigin was set is opaque, which turned the whole
  // map black on the next start for anyone who had used the app already.
  const wantsCors = request.mode === 'cors';
  const usable = res => !!res && !(wantsCors && res.type === 'opaque');

  // a deliberately saved map wins over the browsing cache and over the network
  const saved = await caches.open(OFFLINE_CACHE);
  const savedHit = await saved.match(request);
  if (usable(savedHit)) return savedHit;

  const cache = await caches.open(TILE_CACHE);
  const hit = await cache.match(request);
  if (usable(hit)) return hit;

  try {
    const res = await fetch(request);
    // Only responses this app can actually use again are kept. Storing an
    // opaque one poisons the cache for the next load, and Cache Storage pads it
    // by megabytes into the bargain — see saveTiles().
    if (res.ok) {
      // a full tile cache must not break tile loading
      cache.put(request, res.clone()).then(() => trimTiles(cache)).catch(() => {});
    }
    return res;
  } catch {
    return new Response('', { status: 504, statusText: 'Tile unavailable' });
  }
}

// ── saving a map for the trail ───────────────────────────────────────
// The page works out which tiles the route needs and sends the list here. The
// worker does the fetching because its own fetch() does not pass through the
// fetch handler above, so nothing lands in the browsing cache as a side effect
// and gets counted twice.

// Set by a cancel message. On a poor connection a save is minutes of work, and
// a walker who started one by mistake at the trailhead needs a way out of it.
let saveCancelled = false;

self.addEventListener('message', event => {
  const msg = event.data;
  if (!msg) return;
  if (msg.type === 'save-tiles') event.waitUntil(saveTiles(msg.urls || [], event.source));
  if (msg.type === 'cancel-save') saveCancelled = true;
  if (msg.type === 'forget-tiles') event.waitUntil(forgetTiles(msg.urls || [], event.source));
});

async function saveTiles(urls, client) {
  const cache = await caches.open(OFFLINE_CACHE);
  const total = urls.length;
  let done = 0, saved = 0, failed = 0, quota = false;
  saveCancelled = false;

  const post = extra => client && client.postMessage(
    { type: 'save-progress', done, total, saved, failed, quota, ...extra });

  let next = 0;
  async function worker() {
    while (next < total && !quota && !saveCancelled) {
      const url = urls[next++];
      const req = new Request(url);      // CORS, deliberately — see below
      try {
        if (await cache.match(req)) {
          saved++;                       // already held from an earlier save
        } else {
          // Fetched as CORS rather than no-cors, which matters far more than it
          // looks. An opaque response is padded in Cache Storage accounting so
          // its true size cannot be probed cross-origin, and Chrome's padding is
          // about 7 MB per response: saving this route opaquely charged 1 GB of
          // quota for 3 MB of tiles and died part-way through. All three tile
          // hosts send Access-Control-Allow-Origin, so a CORS response is
          // readable, is accounted at its real size, and still renders for the
          // plain <img> requests Leaflet makes, because a cache entry is keyed
          // on URL and not on the mode it was fetched with.
          const res = await fetch(req);
          if (res.ok) { await cache.put(req, res); saved++; }
          else failed++;
        }
      } catch (err) {
        if (err && err.name === 'QuotaExceededError') quota = true;
        failed++;
      }
      done++;
      if (done % 5 === 0 || done === total) post();
    }
  }

  await Promise.all(Array.from({ length: SAVE_CONCURRENCY }, worker));
  post({ finished: true, cancelled: saveCancelled });
  saveCancelled = false;
}

async function forgetTiles(urls, client) {
  const cache = await caches.open(OFFLINE_CACHE);
  if (urls.length) {
    for (const url of urls) await cache.delete(url);
  } else {
    await caches.delete(OFFLINE_CACHE);   // no list: drop the lot
  }
  if (client) client.postMessage({ type: 'save-progress', done: 0, total: 0, saved: 0, failed: 0, finished: true, cleared: true });
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
