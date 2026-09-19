// UMS Walk & Hike 2026 — interactive route map, progress tracker and weather.

import { Route, ProgressTracker, haversine, formatDistance, splitDistance, formatDuration } from './geo.js';
import { CATEGORY, poiIcon, legendIcon, checkpointIcon, clusterIcon, meIcon, weatherIcon } from './icons.js';
import { loadWeather, cachedWeather, psiBand, pm25Band, uvBand } from './weather.js';

const $ = sel => document.querySelector(sel);

// Panning and zooming are confined to the route plus this much breathing room.
const CORRIDOR_M = 2000;
// how many zoom levels beyond the corridor fit the user may zoom out
const ZOOM_OUT_SLACK = 1;
const FOLLOW_INTERVAL_MS = 1000;
// how much of each compass reading to take; the rest is the previous value
const HEADING_SMOOTHING = 0.25;
// after this long without a compass reading, GPS course may drive the arrow again
const COMPASS_STALE_MS = 6000;

// Battery saver: instead of holding the GPS on continuously, ask for one fix
// this often. Android powers the receiver down between requests.
const SAVER_POLL_MS = 30 * 1000;
// a fix under canopy can take a while; give it this long before giving up
const SAVER_FIX_TIMEOUT_MS = 25 * 1000;

// Progress is written to storage this often while on route, and a saved walk
// older than this is treated as a previous day's and discarded on start-up.
const PROGRESS_SAVE_MS = 5 * 1000;
const PROGRESS_MAX_AGE_MS = 8 * 60 * 60 * 1000;
const PROGRESS_KEY = 'ums-progress';

// Who to call. 995 is SCDF's emergency line. Fill in the marshal for the event
// and the card shows a button for them; leave the number blank and it does not.
const CALLS = [
  { tel: '995', label: 'Call 995', sub: 'SCDF ambulance / fire', primary: true },
  { tel: '', label: 'Call the event marshal', sub: 'not set — see CALLS in js/app.js' },
  { tel: '1800-471-7300', label: 'NParks helpline', sub: '1800-471-7300' },
];
const WEATHER_REFRESH_MS = 5 * 60 * 1000;

const state = {
  map: null,
  route: null,
  tracker: null,
  checkpoints: [],
  pois: {},
  layers: {},
  baseLayers: {},
  activeBase: null,
  marker: null,
  accuracyRing: null,
  doneLine: null,
  lastFix: null,
  lastProgress: null,
  lastAccuracy: null,
  wxFailures: 0,
  wxRetry: null,
  hudAutoMinimised: false,
  following: false,
  followTimer: null,
  watchId: null,
  weatherTimer: null,
  heading: null,          // smoothed bearing, degrees clockwise from true north
  headingCss: null,       // the same angle left unwrapped, for the CSS rotation
  compassAt: null,
  compassOn: false,
  compassNeedsGesture: false,
  wakeLock: null,
  batterySaver: false,
  gpsMode: null,          // 'watch' | 'poll' | null
  pollTimer: null,
  lastFixAt: null,
  progressSavedAt: 0,
  restored: false,
};

// ── base maps ────────────────────────────────────────────────────────
const ONEMAP_ATTR =
  'Map data &copy; <a href="https://www.onemap.gov.sg/">OneMap</a> / Singapore Land Authority';
const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

const BASEMAPS = [
  {
    id: 'onemap',
    name: 'OneMap (SLA)',
    note: 'Official SLA national basemap — shows park connectors, trails and nature-reserve paths.',
    tint: '#e8e3d8',
    tiles: 'https://www.onemap.gov.sg/maps/tiles/Default/{z}/{x}/{y}.png',
    opts: { minZoom: 11, maxZoom: 19, attribution: ONEMAP_ATTR },
  },
  {
    id: 'trail',
    name: 'Trail map',
    note: 'Muted OneMap base with every footpath and trail in the corridor drawn on top, aligned 1:1 with the ground.',
    tint: '#cfd6cd',
    trails: true,
    tiles: 'https://www.onemap.gov.sg/maps/tiles/Grey/{z}/{x}/{y}.png',
    opts: { minZoom: 11, maxZoom: 19, attribution: ONEMAP_ATTR },
  },
  {
    id: 'satellite',
    name: 'Satellite',
    note: 'Esri World Imagery. Canopy hides most trail surface inside the reserve.',
    tint: '#3f5340',
    tiles: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    opts: { maxZoom: 19, attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics' },
  },
  {
    id: 'osm',
    name: 'Street (OSM)',
    note: 'OpenStreetMap standard — the same data the markers come from.',
    tint: '#f2efe9',
    tiles: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    opts: { maxZoom: 19, attribution: OSM_ATTR },
  },
];

// The picker shows a real tile from each base map rather than a flat colour, so
// it previews what the map will actually look like. Taking it from the middle
// of the route means it is usually already in the tile cache, and it comes from
// the same URL template the layer itself uses — one source of truth, so a
// thumbnail cannot drift from the map it stands for. `tint` is only the colour
// behind the image while it loads, or if it never does.
const THUMB_ZOOM = 15;

function thumbUrl(spec, lat, lon) {
  const n = 2 ** THUMB_ZOOM;
  const rad = lat * Math.PI / 180;
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
  // replaced by name, so Esri's {z}/{y}/{x} ordering needs no special case
  return spec.tiles.replace('{z}', THUMB_ZOOM).replace('{x}', x).replace('{y}', y);
}

// ── boot ─────────────────────────────────────────────────────────────
init().catch(err => {
  console.error(err);
  toast('Could not load the route data.');
  $('#hud-status').textContent = 'Failed to load route data';
});

async function init() {
  const [routeDoc, poiDoc, cpDoc, trailDoc, photoDoc] = await Promise.all([
    fetchJSON('data/route.json'),
    fetchJSON('data/pois.json'),
    fetchJSON('data/checkpoints.json'),
    fetchJSON('data/trails.json').catch(() => ({ ways: [] })),
    // optional: a checkpoint with no photo simply does not show one
    fetchJSON('data/photos.json').catch(() => ({ photos: {} })),
  ]);

  state.route = new Route(routeDoc);
  state.tracker = new ProgressTracker(state.route);
  state.pois = poiDoc.categories || {};
  state.checkpoints = cpDoc.checkpoints || [];
  state.photos = photoDoc.photos || {};

  buildMap(routeDoc, trailDoc);
  buildRoute();
  buildCheckpoints();
  buildPois();
  buildLayerUI();
  wireControls();
  wireSos();
  renderProgress(null);
  restoreProgress();

  startLocating();
  startCompass();
  startWeather();
  registerServiceWorker();
}

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

// ── map ──────────────────────────────────────────────────────────────
function buildMap(routeDoc, trailDoc) {
  const b = routeDoc.bounds;
  // the corridor around the route, converted to degrees at this latitude
  const dLat = CORRIDOR_M / 110574;
  const dLon = CORRIDOR_M / (111320 * Math.cos(((b.minLat + b.maxLat) / 2) * Math.PI / 180));
  const limit = L.latLngBounds(
    [b.minLat - dLat, b.minLon - dLon],
    [b.maxLat + dLat, b.maxLon + dLon],
  );
  state.limitBounds = limit;
  state.routeBounds = L.latLngBounds([b.minLat, b.minLon], [b.maxLat, b.maxLon]);

  const map = L.map('map', {
    zoomControl: false,
    attributionControl: true,
    maxBounds: limit,
    maxBoundsViscosity: 1,      // hard wall: the map cannot be dragged outside
    maxZoom: 19,
    zoomSnap: 0.25,
    tap: false,
  });
  state.map = map;
  map.attributionControl.setPrefix('');

  for (const spec of BASEMAPS) state.baseLayers[spec.id] = L.tileLayer(spec.tiles, spec.opts);

  // trail overlay, drawn from the same OSM extract as the markers
  const trails = L.layerGroup();
  for (const way of trailDoc.ways || []) {
    L.polyline(way.pts, {
      color: way.kind === 'steps' ? '#8d6e4a' : '#a4744a',
      weight: 1.6,
      opacity: 0.75,
      dashArray: way.kind === 'steps' ? '3 3' : null,
      interactive: false,
    }).addTo(trails);
  }
  state.layers.trails = trails;

  map.fitBounds(state.routeBounds, { padding: [30, 30] });
  applyBounds();
  // the fence depends on how much of the world the viewport covers, so it is
  // re-derived whenever that changes
  map.on('resize zoomend', applyBounds);
  // panning by hand means the walker wants to look elsewhere; zooming does not
  map.on('dragstart', () => {
    if (state.following && !state.programmaticMove) setFollowing(false, true);
  });

  setBasemap(localStorage.getItem('ums-basemap') || 'onemap');
}

/**
 * Re-derive the zoom floor and the panning fence for the current viewport.
 *
 * `getBoundsZoom(..., true)` is the zoom at which the viewport still fits inside
 * the corridor; we allow one level further out so the whole route and its
 * surroundings can be taken in at a glance.
 *
 * The fence needs a second look. The route is wide and shallow — 3.4 km across,
 * 2.6 km deep — so on a tall phone, fitting its width makes the viewport taller
 * than the 1 km corridor. Leaflet then clamps the centre and the map cannot be
 * dragged vertically *at all*, which also stops popups panning clear of the
 * header. A fence smaller than the screen is not a fence anyway, so in that
 * case it is grown to just over the viewport: nothing new becomes visible, the
 * map simply stops being frozen.
 */
function applyBounds() {
  const map = state.map;
  const corridor = state.limitBounds;

  const fit = map.getBoundsZoom(corridor, true);
  map.setMinZoom(Math.max(10, Math.floor(fit * 4) / 4 - ZOOM_OUT_SLACK));

  // Slack big enough that any marker can be brought into the clear band between
  // the panels — measured from the panels themselves, not guessed.
  const slackPx = Math.max(
    300,                                    // enough for a tall popup with a photo
    $('#hud').offsetHeight + $('#wx-toggle').offsetHeight + 140,
  );
  const origin = map.containerPointToLatLng([0, 0]);
  const padded = map.containerPointToLatLng([-slackPx, -slackPx]);
  const slackLat = Math.abs(padded.lat - origin.lat);
  const slackLon = Math.abs(origin.lng - padded.lng);

  const view = map.getBounds();
  const centre = corridor.getCenter();
  const halfLat = Math.max(
    corridor.getNorth() - corridor.getSouth(),
    (view.getNorth() - view.getSouth()) + 2 * slackLat,
  ) / 2;
  const halfLon = Math.max(
    corridor.getEast() - corridor.getWest(),
    (view.getEast() - view.getWest()) + 2 * slackLon,
  ) / 2;
  map.setMaxBounds(L.latLngBounds(
    [centre.lat - halfLat, centre.lng - halfLon],
    [centre.lat + halfLat, centre.lng + halfLon],
  ));
}

function setBasemap(id) {
  const spec = BASEMAPS.find(s => s.id === id) || BASEMAPS[0];
  if (state.activeBase === spec.id) return;
  for (const layer of Object.values(state.baseLayers)) state.map.removeLayer(layer);
  state.baseLayers[spec.id].addTo(state.map);
  state.baseLayers[spec.id].bringToBack();
  state.activeBase = spec.id;

  // the trail map is the base plus the trail overlay
  const trailsBox = $('#chk-trails');
  if (spec.trails && !state.map.hasLayer(state.layers.trails)) {
    state.layers.trails.addTo(state.map);
    if (trailsBox) trailsBox.checked = true;
  }

  localStorage.setItem('ums-basemap', spec.id);
  $('#basemap-note').textContent = spec.note;
  for (const btn of document.querySelectorAll('#basemaps button')) {
    btn.setAttribute('aria-checked', String(btn.dataset.id === spec.id));
  }
}

// ── route, checkpoints, markers ──────────────────────────────────────
function buildRoute() {
  const pts = state.route.latLngs();
  L.polyline(pts, { color: '#000', weight: 9, opacity: 0.25, interactive: false }).addTo(state.map);
  state.routeLine = L.polyline(pts, {
    color: '#ff5a3c', weight: 5, opacity: 0.95, lineJoin: 'round', lineCap: 'round',
  }).addTo(state.map);
  // the part already walked, drawn over the top
  state.doneLine = L.polyline([], {
    color: '#35d39a', weight: 5, opacity: 0.95, lineJoin: 'round', lineCap: 'round', interactive: false,
  }).addTo(state.map);

  const km = L.layerGroup();
  for (let d = 1000; d < state.route.total; d += 1000) {
    const [lat, lon] = state.route.atDistance(d);
    L.circleMarker([lat, lon], {
      radius: 4.5, color: '#fff', weight: 2, fillColor: '#ff5a3c', fillOpacity: 1,
    }).bindTooltip(`${d / 1000} km`, { direction: 'top', offset: [0, -5] }).addTo(km);
  }
  state.layers.km = km.addTo(state.map);
}

function buildCheckpoints() {
  const group = L.layerGroup();
  state.checkpoints.forEach((cp, i) => {
    const isStart = cp.id === 'start';
    const isFinish = cp.id === 'finish';
    const kind = isStart ? 'start' : isFinish ? 'finish' : 'cp';
    const label = isStart || isFinish ? '' : String(i);
    const remaining = state.route.total - cp.along;
    L.marker([cp.lat, cp.lon], { icon: checkpointIcon(kind, label), zIndexOffset: 600 })
      .bindPopup(
        photoHtml(cp.id) +
        `<div class="pop-t">${label ? `${label}. ` : ''}${escapeHtml(cp.name)}</div>` +
        (cp.note ? `<div class="pop-d">${escapeHtml(cp.note)}</div>` : '') +
        `<div class="pop-m">km ${(cp.along / 1000).toFixed(2)} · ${formatDistance(remaining)} to finish` +
        (cp.offset > 40 ? ` · ${cp.offset} m off the path` : '') + '</div>',
        { maxWidth: state.photos[cp.id] ? 280 : 300 })
      .addTo(group);
  });
  state.layers.checkpoints = group.addTo(state.map);

  const ticks = $('#bar-ticks');
  ticks.innerHTML = state.checkpoints
    .filter(cp => cp.along > 0 && cp.along < state.route.total)
    .map(cp => `<i style="left:${(cp.along / state.route.total * 100).toFixed(2)}%"></i>`)
    .join('');

  $('#hud-note').textContent =
    `${(state.route.total / 1000).toFixed(2)} km loop · ${state.checkpoints.length - 2} landmarks · ` +
    `${state.route.doc.elevation.gain} m ascent`;
}

/**
 * Facility markers, in one cluster group.
 *
 * Facilities bunch up: the ranger station has a toilet, a water point and an AED
 * within ten metres of each other, and the pins hid one another completely. They
 * all live in a single cluster group so overlaps *between* categories collapse
 * too, and the cluster shows which kinds of facility it holds rather than an
 * anonymous count. Categories stay individually toggleable by adding and
 * removing their markers from the group.
 */
/**
 * Photo for a popup, keyed by checkpoint or facility id, with the credit the
 * licence requires (omitted when `credit` is empty, as it is for our own).
 *
 * Loaded lazily and only when the popup opens, so the images cost nothing until
 * someone actually taps a checkpoint.
 */
function photoHtml(id) {
  const photo = state.photos?.[id];
  if (!photo) return '';
  // No credit, no caption — an empty one still paints its gradient band.
  const caption = [photo.credit, photo.licence].filter(Boolean).join(' · ');
  return `<figure class="pop-photo">
    <img src="${escapeHtml(photo.file)}" alt="" decoding="async">
    ${caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : ''}
  </figure>`;
}

function buildPois() {
  const cluster = L.markerClusterGroup({
    maxClusterRadius: 46,          // px: only pins that genuinely overlap
    spiderfyOnMaxZoom: true,
    showCoverageOnHover: false,
    zoomToBoundsOnClick: false,    // handled below, so a tap always shows the list
    disableClusteringAtZoom: 18,   // close in, every pin stands on its own
    spiderLegPolylineOptions: { weight: 1.4, color: '#93a6a1', opacity: 0.7 },
    iconCreateFunction(c) {
      const counts = {};
      for (const m of c.getAllChildMarkers()) {
        counts[m.options.category] = (counts[m.options.category] || 0) + 1;
      }
      return clusterIcon(counts, c.getChildCount());
    },
  });
  state.cluster = cluster;
  state.markersByCategory = {};

  for (const [cat, meta] of Object.entries(CATEGORY)) {
    const markers = (state.pois[cat] || []).map(p =>
      L.marker([p.lat, p.lon], {
        icon: poiIcon(cat),
        category: cat,
        zIndexOffset: cat === 'aed' ? 500 : 0,
      }).bindPopup(
        photoHtml(p.id) +
        `<div class="pop-t">${escapeHtml(p.name === meta.label ? meta.label : p.name)}</div>` +
        (p.detail ? `<div class="pop-d">${escapeHtml(p.detail)}</div>` : '') +
        (p.note ? `<div class="pop-n">${escapeHtml(p.note)}</div>` : '') +
        `<div class="pop-m">km ${(p.along / 1000).toFixed(2)} on route · ${p.offset} m off the path</div>`,
        { maxWidth: (p.note || state.photos[p.id]) ? 280 : 300 }));

    state.markersByCategory[cat] = markers;
    cluster.addLayers(markers);
  }

  // A tap on a cluster lists what is inside, which is more use than zooming and
  // hunting. The list links each entry to its own marker.
  cluster.on('clusterclick', ev => {
    const children = ev.layer.getAllChildMarkers()
      .slice()
      .sort((a, b) => a.options.category.localeCompare(b.options.category));
    const rows = children.map((m, i) => {
      const cat = m.options.category;
      const title = m.getPopup().getContent().match(/class="pop-t">([^<]*)</)?.[1] || CATEGORY[cat].label;
      const detail = m.getPopup().getContent().match(/class="pop-d">([^<]*)</)?.[1] || '';
      return `<li><button type="button" data-i="${i}">
        ${legendIcon(cat)}
        <span><b>${title}</b>${detail ? `<em>${detail}</em>` : ''}</span>
      </button></li>`;
    }).join('');

    const popup = L.popup({ maxWidth: 290, className: 'cluster-popup' })
      .setLatLng(ev.layer.getLatLng())
      .setContent(`<div class="pop-t">${children.length} facilities here</div><ul class="cl-list">${rows}</ul>`)
      .openOn(state.map);

    // hand off to the individual marker when a row is chosen
    const el = popup.getElement();
    el?.querySelectorAll('button[data-i]').forEach(btn => {
      btn.addEventListener('click', () => {
        const marker = children[Number(btn.dataset.i)];
        state.map.closePopup(popup);
        state.cluster.zoomToShowLayer(marker, () => marker.openPopup());
      });
    });
  });

  cluster.addTo(state.map);
  state.layers.facilities = cluster;
}

// ── layer / marker UI ────────────────────────────────────────────────
function buildLayerUI() {
  const mid = state.routeBounds.getCenter();
  $('#basemaps').innerHTML = BASEMAPS.map(spec =>
    `<button type="button" role="radio" data-id="${spec.id}" aria-checked="false">
       <img class="sw" src="${thumbUrl(spec, mid.lat, mid.lng)}" alt="" aria-hidden="true"
            decoding="async" style="background:${spec.tint}">
       <span class="nm">${escapeHtml(spec.name)}</span>
       <span class="pick" aria-hidden="true"></span>
     </button>`).join('');
  for (const btn of document.querySelectorAll('#basemaps button')) {
    btn.addEventListener('click', () => setBasemap(btn.dataset.id));
  }
  $('#basemap-note').textContent = (BASEMAPS.find(s => s.id === state.activeBase) || BASEMAPS[0]).note;
  for (const btn of document.querySelectorAll('#basemaps button')) {
    btn.setAttribute('aria-checked', String(btn.dataset.id === state.activeBase));
  }

  $('#overlays').innerHTML = Object.entries(CATEGORY).map(([cat, meta]) => {
    const n = (state.pois[cat] || []).length;
    return `<label>
      <input type="checkbox" data-layer="${cat}" checked>
      ${legendIcon(cat)}
      <span class="n">${meta.plural}</span><span class="c">${n}</span>
    </label>`;
  }).join('');

  $('#route-overlays').innerHTML = `
    <label><input type="checkbox" data-layer="checkpoints" checked>
      <span class="n">Checkpoints</span></label>
    <label><input type="checkbox" data-layer="km" checked>
      <span class="n">Kilometre markers</span></label>
    <label><input type="checkbox" id="chk-trails" data-layer="trails">
      <span class="n">Trails &amp; footpaths</span></label>
    <label><input type="checkbox" id="chk-saver">
      <span class="n">Battery saver GPS</span><span class="c">fix every ${SAVER_POLL_MS / 1000} s</span></label>
    <label><input type="checkbox" id="chk-follow">
      <span class="n">Follow me</span><span class="c">1 s</span></label>
    <button type="button" id="btn-reset" class="btn subtle">Reset progress to the start</button>`;

  for (const box of document.querySelectorAll('[data-layer]')) {
    box.addEventListener('change', () => {
      const key = box.dataset.layer;
      const markers = state.markersByCategory?.[key];
      if (markers) {
        // facility categories live inside the shared cluster group
        if (box.checked) state.cluster.addLayers(markers);
        else state.cluster.removeLayers(markers);
        return;
      }
      const layer = state.layers[key];
      if (!layer) return;
      if (box.checked) layer.addTo(state.map); else state.map.removeLayer(layer);
    });
  }
  $('#chk-follow').addEventListener('change', e => setFollowing(e.target.checked));
  $('#chk-saver').addEventListener('change', e => setBatterySaver(e.target.checked));
  setBatterySaver(localStorage.getItem('ums-saver') === '1');
  $('#btn-reset').addEventListener('click', () => {
    if (confirm('Reset progress and start tracking from the start line again?')) resetProgress();
  });
  if (state.map.hasLayer(state.layers.trails)) $('#chk-trails').checked = true;
}

// ── controls ─────────────────────────────────────────────────────────
function wireControls() {
  $('#btn-zoom-in').addEventListener('click', () => state.map.zoomIn(1));
  $('#btn-zoom-out').addEventListener('click', () => state.map.zoomOut(1));
  $('#btn-fit').addEventListener('click', () => {
    setFollowing(false);
    state.map.flyToBounds(state.routeBounds, { padding: [30, 30], duration: 0.6 });
  });
  $('#btn-locate').addEventListener('click', centreOnMe);
  $('#btn-follow').addEventListener('click', () => setFollowing(!state.following));

  const layersBtn = $('#btn-layers');
  layersBtn.addEventListener('click', () => {
    const open = $('#layers').hidden;
    if (open && window.innerWidth <= 720 && weatherOpen()) setWeatherOpen(false);
    $('#layers').hidden = !open;
    layersBtn.setAttribute('aria-pressed', String(open));
  });

  $('#hud-toggle').addEventListener('click', () => setHudOpen(!hudOpen()));

  // A marker near the top of the corridor cannot be panned clear of the HUD —
  // maxBounds stops the map moving that far — and Leaflet's popup pane cannot
  // be raised above the panels, since the fixed-position map is its own
  // stacking context. So the HUD folds itself away while a popup covers it,
  // and springs back when the popup closes.
  state.map.on('popupopen', e => {
    if (!hudOpen()) return;
    const popup = e.popup.getElement();
    const hud = $('#hud').getBoundingClientRect();
    if (!popup) return;
    const box = popup.getBoundingClientRect();
    const overlaps = !(box.bottom <= hud.top || box.top >= hud.bottom
      || box.right <= hud.left || box.left >= hud.right);
    if (overlaps) {
      state.hudAutoMinimised = true;
      setHudOpen(false);
      // the HUD has shrunk, but the popup does not re-pan itself: nudge the map
      // so the popup clears the smaller header (maxBounds may absorb some of it)
      requestAnimationFrame(() => {
        const safeTop = $('#hud').getBoundingClientRect().bottom + 12;
        const top = popup.getBoundingClientRect().top;
        if (top < safeTop) state.map.panBy([0, top - safeTop], { animate: true, duration: 0.25 });
      });
    }
  });
  state.map.on('popupclose', () => {
    if (!state.hudAutoMinimised) return;
    state.hudAutoMinimised = false;
    setHudOpen(true);
  });

  // The control stack lives in the band between the HUD and the weather panel.
  // Both change height with their content, so measure them and publish the
  // results as CSS variables.
  //
  // Only the summary bar and its risk banner count towards --wx-h: the expanded
  // forecast body is an overlay. Measuring the whole panel instead would push
  // the control stack up into the HUD whenever the forecast is open on a phone.
  const measure = () => {
    const root = document.documentElement.style;
    const bar = $('#wx-toggle').offsetHeight
      + ($('#wx-alert').hidden ? 0 : $('#wx-alert').offsetHeight);
    const hud = $('#hud').offsetHeight;
    root.setProperty('--wx-h', `${Math.round(bar)}px`);
    root.setProperty('--hud-h', `${Math.round(hud)}px`);

    // Popups auto-pan into view on open; without this they slide under the HUD
    // or the weather bar. Instances inherit these from the prototype, so
    // updating it here applies to every popup, including ones already bound.
    L.Popup.prototype.options.autoPanPaddingTopLeft = L.point(14, Math.round(hud) + 22);
    L.Popup.prototype.options.autoPanPaddingBottomRight = L.point(14, Math.round(bar) + 22);
  };
  state.measurePanels = measure;
  measure();
  if ('ResizeObserver' in window) {
    const ro = new ResizeObserver(measure);
    ro.observe($('#wx-toggle'));
    ro.observe($('#wx-alert'));
    ro.observe($('#hud'));
  } else {
    window.addEventListener('resize', measure);
  }

  $('#wx-refresh').addEventListener('click', ev => {
    ev.stopPropagation();
    refreshWeather(true);
  });

  // Collapsing the weather panel hands the space back to the map. The summary
  // bar and any risk banner stay visible and keep refreshing.
  const wxToggle = $('#wx-toggle');
  wxToggle.addEventListener('click', () => setWeatherOpen(!weatherOpen()));
  // both bars start minimised so the map gets the screen; the choice is then
  // remembered per device
  const savedWx = localStorage.getItem('ums-wx-open');
  setWeatherOpen(savedWx === '1', true);
  const savedHud = localStorage.getItem('ums-hud-open');
  if (savedHud !== '1') setHudOpen(false, true);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      refreshWeather(false);
      if (state.following) keepAwake(true);
    }
    applyGpsMode();
  });
  // coverage drops in and out along the trail; grab fresh data the moment it returns
  window.addEventListener('online', () => refreshWeather(false));
}

function hudOpen() {
  return $('#hud-toggle').getAttribute('aria-expanded') === 'true';
}

/** Fold the stat tiles away; the progress bar and status line always stay. */
function setHudOpen(open, initial = false) {
  $('#hud-toggle').setAttribute('aria-expanded', String(open));
  $('#hud-body').hidden = !open;
  // minimised, the status line carries the numbers, so re-render it now
  renderProgress(state.lastProgress ?? null, state.lastAccuracy);
  state.measurePanels?.();
  // an automatic fold for a popup must not overwrite the walker's own choice
  if (!initial && !state.hudAutoMinimised) {
    localStorage.setItem('ums-hud-open', open ? '1' : '0');
  }
}

function centreOnMe() {
  if (!state.lastFix) {
    toast('Waiting for a GPS fix…');
    return;
  }
  moveMap(state.lastFix, Math.max(state.map.getZoom(), 17));
}

// ── emergency card ───────────────────────────────────────────────────
// One tap for the moment nobody wants: who to call, where you are in a form
// you can read out or paste into a message, and the nearest defibrillator,
// shelter and landmark from your last fix. The AED data was already on the map;
// nobody should be hunting through markers with an incident in front of them.

function wireSos() {
  $('#btn-sos').addEventListener('click', () => openSos($('#sos').hidden));
  $('#sos-close').addEventListener('click', () => openSos(false));
  $('#sos-copy').addEventListener('click', copyLocation);
  if (navigator.share) {
    const share = $('#sos-share');
    share.hidden = false;
    share.addEventListener('click', () => {
      navigator.share({ title: 'UMS Walk & Hike — my location', text: locationText() }).catch(() => {});
    });
  }

  $('#sos-calls').innerHTML = CALLS.filter(c => c.tel).map(c =>
    `<a href="tel:${escapeHtml(c.tel)}"${c.primary ? '' : ' class="secondary"'}>
       <span>${escapeHtml(c.label)}</span><small>${escapeHtml(c.sub)}</small>
     </a>`).join('');
}

function openSos(open) {
  const panel = $('#sos');
  panel.hidden = !open;
  $('#btn-sos').setAttribute('aria-pressed', String(open));
  if (open) {
    // one panel at a time on the map
    if (!$('#layers').hidden) {
      $('#layers').hidden = true;
      $('#btn-layers').setAttribute('aria-pressed', 'false');
    }
    if (window.innerWidth <= 720 && weatherOpen()) setWeatherOpen(false);
    renderSos();
  }
}

/** Plain text of where the walker is, for reading out or pasting into a message. */
function locationText() {
  if (!state.lastFix) return 'No GPS fix yet.';
  const [lat, lon] = state.lastFix;
  const p = state.lastProgress;
  const along = p && p.onRoute ? p.along : null;
  const parts = [`I'm at ${lat.toFixed(5)}, ${lon.toFixed(5)}`];
  if (state.lastAccuracy) parts[0] += ` (±${Math.round(state.lastAccuracy)} m)`;
  parts.push(`https://maps.google.com/?q=${lat.toFixed(5)},${lon.toFixed(5)}`);
  if (along != null) {
    const near = nearestCheckpoint(lat, lon, along);
    // "past" and "before" read better than "back" and "ahead" for a marshal
    // being told where to come: it is the landmark that is fixed, not them.
    parts.push(`On the UMS walk route at km ${(p.along / 1000).toFixed(2)}`
      + (near ? `, ${formatDistance(near.d)} ${near.dir === 'back' ? 'past' : 'before'} ${near.cp.name}` : ''));
  }
  return parts.join('\n');
}

/**
 * How far it is to walk to something at `target` metres along the route, and
 * which way to set off.
 *
 * Straight-line distance is close to useless here. The loop runs round a
 * reservoir and through closed forest, so a toilet 1.4 km across the water is
 * 3.6 km of walking, and the marker that looks nearest on the map is regularly
 * not the nearest one to reach. On a loop either direction is fair game, so
 * both are measured and the shorter wins; `off` is the walk from the path to
 * the thing itself.
 */
function routeWalk(target, along, off = 0) {
  const total = state.route.total;
  const raw = target - along;
  let fwd, back;
  if (state.route.isLoop) {
    fwd = ((raw % total) + total) % total;
    back = (total - fwd) % total;
  } else {
    fwd = raw >= 0 ? raw : Infinity;
    back = raw < 0 ? -raw : Infinity;
  }
  const ahead = fwd <= back;
  return { d: (ahead ? fwd : back) + off, dir: ahead ? 'ahead' : 'back' };
}

/**
 * `along` is where the walker is on the route, or null when they are off it —
 * then there is no route distance to give and this falls back to straight line,
 * which the card labels as such.
 */
function measure(lat, lon, targetLat, targetLon, targetAlong, off, along) {
  if (along == null || targetAlong == null) {
    return { d: haversine(lat, lon, targetLat, targetLon), dir: null };
  }
  return routeWalk(targetAlong, along, off);
}

function nearestCheckpoint(lat, lon, along) {
  let best = null;
  for (const cp of state.checkpoints) {
    if (cp.id === 'finish') continue;                   // same place as the start
    const m = measure(lat, lon, cp.lat, cp.lon, cp.along, 0, along);
    if (!best || m.d < best.d) best = { cp, ...m };
  }
  return best;
}

function nearestPoi(cat, lat, lon, along) {
  let best = null;
  (state.pois[cat] || []).forEach((p, i) => {
    const m = measure(lat, lon, p.lat, p.lon, p.along, p.offset, along);
    if (!best || m.d < best.d) best = { p, i, ...m };
  });
  return best;
}

/** "1.3 km ahead", "400 m back", or a bare distance when off route. */
function walkLabel(m) {
  return `${formatDistance(m.d)}${m.dir ? ` ${m.dir}` : ''}`;
}

function renderSos() {
  const where = $('#sos-where');
  const list = $('#sos-near');

  if (!state.lastFix) {
    where.textContent = 'Waiting for a GPS fix… The numbers below will fill in as soon as there is one.';
    list.innerHTML = '<li class="none">Nearest help is worked out from your position once there is a fix.</li>';
    $('#sos-note').textContent = 'Distances follow the route once there is a fix.';
    return;
  }

  const [lat, lon] = state.lastFix;
  const age = state.lastFixAt ? Math.round((Date.now() - state.lastFixAt) / 1000) : null;
  const p = state.lastProgress;
  const along = p && p.onRoute ? p.along : null;
  const near = nearestCheckpoint(lat, lon, along);
  where.innerHTML =
    `<b>${lat.toFixed(5)}, ${lon.toFixed(5)}</b>`
    + (state.lastAccuracy ? ` · ±${Math.round(state.lastAccuracy)} m` : '')
    + (age != null ? ` · ${age < 5 ? 'just now' : `${age} s ago`}` : '')
    + (along != null ? `<br>km ${(along / 1000).toFixed(2)} on the route` : '<br>Off the route')
    + (near ? `<br>${formatDistance(near.d)} ${near.dir === 'back' ? 'past' : near.dir === 'ahead' ? 'before' : 'from'} ${escapeHtml(near.cp.name)}` : '');

  const rows = [];
  for (const cat of ['aed', 'water', 'toilet', 'shelter']) {
    const hit = nearestPoi(cat, lat, lon, along);
    if (!hit) continue;
    const { p: poi, i } = hit;
    const label = CATEGORY[cat].label;
    rows.push(`<li data-cat="${cat}" data-i="${i}">
      ${legendIcon(cat)}
      <span class="t">${escapeHtml(poi.name === label ? label : poi.name)}
        <small>${escapeHtml([poi.name !== label ? label : '', poi.detail].filter(Boolean).join(' · '))}</small>
      </span>
      <span class="d">${formatDistance(hit.d)}${hit.dir ? `<small>${hit.dir}</small>` : ''}</span>
    </li>`);
  }
  if (near) {
    rows.push(`<li data-cp="${escapeHtml(near.cp.id)}">
      <span class="ico cp-ico" aria-hidden="true">${escapeHtml(String(near.cp.id).replace('cp', '') || '★')}</span>
      <span class="t">${escapeHtml(near.cp.name)}<small>Nearest checkpoint — a landmark to describe</small></span>
      <span class="d">${formatDistance(near.d)}${near.dir ? `<small>${near.dir}</small>` : ''}</span>
    </li>`);
  }
  list.innerHTML = rows.join('') || '<li class="none">No facilities in the data.</li>';
  // off the route there is no route distance to give, so say which it is
  $('#sos-note').textContent = along != null
    ? 'Distances follow the route from your last fix, the shorter way round. Tap a row to see it on the map.'
    : 'Off the route, so these are straight-line distances — the walk may be much further. Tap a row to see it on the map.';

  for (const li of list.querySelectorAll('li[data-cat]')) {
    li.addEventListener('click', () => {
      const marker = state.markersByCategory[li.dataset.cat][Number(li.dataset.i)];
      openSos(false);
      setFollowing(false, true);
      state.cluster.zoomToShowLayer(marker, () => marker.openPopup());
    });
  }
  for (const li of list.querySelectorAll('li[data-cp]')) {
    li.addEventListener('click', () => {
      const cp = state.checkpoints.find(c => c.id === li.dataset.cp);
      openSos(false);
      setFollowing(false, true);
      moveMap([cp.lat, cp.lon], Math.max(state.map.getZoom(), 17));
    });
  }
}

async function copyLocation() {
  const text = locationText();
  try {
    await navigator.clipboard.writeText(text);
    toast('Location copied — paste it into a message');
  } catch {
    // no clipboard (insecure origin, or denied): leave it selectable on screen
    const range = document.createRange();
    range.selectNodeContents($('#sos-where'));
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    toast('Could not copy automatically — the text is selected, copy it by hand');
  }
}

// ── keeping the screen on ────────────────────────────────────────────
// Follow mode means the phone is being used as a live map, and a phone that
// sleeps after thirty seconds also stops delivering GPS fixes. The lock is
// released by the browser whenever the page is hidden, so it is re-requested
// when the page comes back while still following.

async function keepAwake(on) {
  if (!('wakeLock' in navigator)) return;
  if (!on) {
    if (state.wakeLock) { state.wakeLock.release().catch(() => {}); state.wakeLock = null; }
    return;
  }
  if (state.wakeLock) return;
  try {
    state.wakeLock = await navigator.wakeLock.request('screen');
    state.wakeLock.addEventListener('release', () => { state.wakeLock = null; });
  } catch {
    // low battery or a policy: the map still works, the screen just may sleep
  }
}

function moveMap(latlng, zoom) {
  state.programmaticMove = true;
  state.map.setView(latlng, zoom, { animate: true, duration: 0.35 });
  setTimeout(() => { state.programmaticMove = false; }, 500);
}

function setFollowing(on, silent = false) {
  state.following = on;
  $('#btn-follow').setAttribute('aria-pressed', String(on));
  const box = $('#chk-follow');
  if (box) box.checked = on;

  clearInterval(state.followTimer);
  state.followTimer = null;
  keepAwake(on);
  applyGpsMode();

  if (on) {
    if (!state.lastFix) toast('Following — waiting for a GPS fix…');
    else moveMap(state.lastFix, Math.max(state.map.getZoom(), 17));
    // re-centre once a second on the most recent fix, as asked
    state.followTimer = setInterval(() => {
      if (state.lastFix) moveMap(state.lastFix, state.map.getZoom());
    }, FOLLOW_INTERVAL_MS);
  } else if (!silent) {
    toast('Follow off');
  }
}

// ── location & progress ──────────────────────────────────────────────
// Where the app is served from over HTTPS, for the insecure-origin notice below
const SECURE_HOME = 'https://alden000.github.io/UMS-Walk-Hike-2026/';

function startLocating() {
  // Browsers hand out GPS only on a secure context. localhost is exempt, a LAN
  // address over plain HTTP is not, and the failure that comes back looks
  // exactly like a permission denial — which would send someone hunting through
  // phone settings for a problem that is not there. Say what is actually wrong.
  if (!window.isSecureContext) {
    const status = $('#hud-status');
    status.textContent = 'Opened over plain HTTP — GPS and offline need HTTPS';
    status.className = 'warn';
    status.title = `Tracking and offline caching only work on a secure origin. Open ${SECURE_HOME} instead.`;
    toast('No GPS over plain HTTP — open the https:// address for tracking');
    return;
  }

  if (!('geolocation' in navigator)) {
    $('#hud-status').textContent = 'This device has no location support';
    return;
  }
  state.gpsReady = true;
  applyGpsMode();
}

// ── GPS duty cycle ───────────────────────────────────────────────────
// A continuous high-accuracy watch holds the GPS receiver on for the whole
// walk, which is the single biggest drain on the phone. Battery saver swaps it
// for one fix every SAVER_POLL_MS, and the receiver sleeps in between. Follow
// mode always gets the continuous watch: re-centring once a second on a
// position that changes every thirty makes no sense. High accuracy stays on in
// both modes — a network fix is worthless under the canopy.

function applyGpsMode() {
  if (!state.gpsReady) return;
  const want = document.hidden ? null
    : (state.batterySaver && !state.following) ? 'poll' : 'watch';
  if (want === state.gpsMode) return;
  stopGps();
  state.gpsMode = want;
  if (want === 'watch') {
    state.watchId = navigator.geolocation.watchPosition(onFix, onFixError, {
      enableHighAccuracy: true, maximumAge: 2000, timeout: 20000,
    });
  } else if (want === 'poll') {
    pollOnce();
    state.pollTimer = setInterval(pollOnce, SAVER_POLL_MS);
  }
}

function pollOnce() {
  navigator.geolocation.getCurrentPosition(onFix, onFixError, {
    enableHighAccuracy: true, maximumAge: 5000, timeout: SAVER_FIX_TIMEOUT_MS,
  });
}

function stopGps() {
  if (state.watchId != null) navigator.geolocation.clearWatch(state.watchId);
  clearInterval(state.pollTimer);
  state.watchId = null;
  state.pollTimer = null;
  state.gpsMode = null;
}

function setBatterySaver(on) {
  state.batterySaver = on;
  localStorage.setItem('ums-saver', on ? '1' : '0');
  const box = $('#chk-saver');
  if (box) box.checked = on;
  applyGpsMode();
  if (state.lastProgress) renderProgress(state.lastProgress, state.lastAccuracy);
}

function onFix(pos) {
  const { latitude: lat, longitude: lon, accuracy, heading, speed } = pos.coords;
  state.lastFix = [lat, lon];
  state.lastFixAt = pos.timestamp || Date.now();

  // Course over ground, for devices with no usable compass. It only describes
  // the direction of travel, so it says nothing while standing still — and at a
  // standstill it is either null or drift. Ignore it below walking pace.
  if (heading != null && isFinite(heading) && (speed == null || speed > 0.5)) {
    setHeading(heading, 'gps');
  }

  if (!state.marker) {
    state.marker = L.marker([lat, lon], { icon: meIcon(), zIndexOffset: 1000, interactive: false })
      .addTo(state.map);
    state.accuracyRing = L.circle([lat, lon], {
      radius: accuracy, color: '#3b8cff', weight: 1, fillColor: '#3b8cff', fillOpacity: 0.1, interactive: false,
    }).addTo(state.map);
    applyHeading();   // the compass may well have been running before the first fix
  } else {
    state.marker.setLatLng([lat, lon]);
    state.accuracyRing.setLatLng([lat, lon]).setRadius(accuracy);
  }

  const progress = state.tracker.update(lat, lon, pos.timestamp || Date.now());
  state.lastProgress = progress;
  state.lastAccuracy = accuracy;
  state.restored = false;
  renderProgress(progress, accuracy);
  if (progress.onRoute) saveProgress();
  if (!$('#sos').hidden) renderSos();
}

// ── surviving a reload ───────────────────────────────────────────────
// Sooner or later in a four-hour walk the phone kills the tab. Without this,
// coming back restarts the walker at zero with no ETA — and, on a loop, a fix
// near the finish would be read as the start line.

function saveProgress() {
  const now = Date.now();
  if (now - state.progressSavedAt < PROGRESS_SAVE_MS) return;
  const snap = state.tracker.snapshot();
  if (!snap) return;
  state.progressSavedAt = now;
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify({ ...snap, savedAt: now }));
  } catch { /* storage full or blocked: nothing to do but carry on */ }
}

function restoreProgress() {
  let snap = null;
  try { snap = JSON.parse(localStorage.getItem(PROGRESS_KEY) || 'null'); } catch { /* ignore */ }
  if (!snap) return;
  if (!snap.savedAt || Date.now() - snap.savedAt > PROGRESS_MAX_AGE_MS) {
    localStorage.removeItem(PROGRESS_KEY);        // a previous day's walk
    return;
  }
  if (!state.tracker.restore(snap)) return;
  state.restored = true;
  const along = state.tracker.along;
  const total = state.route.total;
  // show the saved numbers straight away rather than zeros until the first fix
  renderProgress({
    along, remaining: total - along, fraction: total ? along / total : 0,
    offset: 0, onRoute: true, speed: null, eta: null, restored: true,
  }, null);
}

function resetProgress() {
  state.tracker.reset();
  state.restored = false;
  localStorage.removeItem(PROGRESS_KEY);
  state.lastProgress = null;
  renderProgress(null);
  state.doneLine.setLatLngs([]);
  toast('Progress reset — tracking from the start again');
}

// ── which way the walker is facing ───────────────────────────────────
// The arrow on the position marker. Two sources, preferred in this order:
//
//   device compass   turns with the walker even when they are standing still,
//                    which is the point of the arrow
//   GPS course       needs no permission and no magnetometer, but only exists
//                    while actually moving (see onFix)
//
// A compass reading is relative to the top of the *device*, so it is corrected
// for how far the screen itself has been rotated. In portrait — how the phone
// will be held on the walk — that correction is zero.

function startCompass() {
  // Same secure-context rule as geolocation, so on a plain-HTTP LAN copy there
  // is no compass either; startLocating() already explains that to the walker.
  if (!window.isSecureContext || !('DeviceOrientationEvent' in window)) return;

  // iOS gates the compass behind a prompt that only a user gesture may raise,
  // so wait for the first tap rather than asking before the map is even drawn.
  if (typeof DeviceOrientationEvent.requestPermission === 'function') {
    state.compassNeedsGesture = true;
    const ask = () => {
      document.removeEventListener('click', ask);
      document.removeEventListener('touchend', ask);
      requestCompass();
    };
    document.addEventListener('click', ask);
    document.addEventListener('touchend', ask, { passive: true });
    return;
  }
  attachCompass();
}

function requestCompass() {
  if (!state.compassNeedsGesture) return;
  state.compassNeedsGesture = false;
  DeviceOrientationEvent.requestPermission()
    .then(res => { if (res === 'granted') attachCompass(); })
    .catch(() => {});   // declining just leaves the arrow on GPS course
}

function attachCompass() {
  if (state.compassOn) return;
  state.compassOn = true;
  // `deviceorientationabsolute` is the true-north event where it is implemented;
  // Safari reports the same thing as webkitCompassHeading on plain
  // `deviceorientation`. Listen for both and use whichever the device sends.
  window.addEventListener('deviceorientationabsolute', onOrientation, true);
  window.addEventListener('deviceorientation', onOrientation, true);
}

function onOrientation(e) {
  let deg = null;
  if (typeof e.webkitCompassHeading === 'number' && isFinite(e.webkitCompassHeading)) {
    deg = e.webkitCompassHeading;          // already degrees clockwise from north
  } else if (e.absolute === true && typeof e.alpha === 'number') {
    deg = 360 - e.alpha;                   // alpha is measured anticlockwise
  }
  if (deg == null) return;

  const screenAngle = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
  setHeading(deg + screenAngle, 'compass');
}

/** Fold a new bearing into the displayed one. */
function setHeading(deg, source) {
  if (deg == null || !isFinite(deg)) return;
  deg = ((deg % 360) + 360) % 360;

  const now = Date.now();
  if (source === 'compass') {
    state.compassAt = now;
  } else if (state.compassAt && now - state.compassAt < COMPASS_STALE_MS) {
    return;                // a live compass beats course over ground
  }

  if (state.heading == null) {
    state.heading = deg;
    state.headingCss = deg;
  } else {
    // Always turn the short way. Without this a walker facing north makes the
    // arrow spin most of a circle every time the reading crosses 0°/360°, and
    // because the CSS angle is left unwrapped the animation follows the short
    // arc too rather than unwinding.
    const step = ((deg - state.heading + 540) % 360) - 180;
    const eased = source === 'compass' ? step * HEADING_SMOOTHING : step;
    state.heading = (state.heading + eased + 360) % 360;
    state.headingCss += eased;
  }
  applyHeading();
}

function applyHeading() {
  if (state.heading == null || !state.marker) return;
  const el = state.marker.getElement();
  const arrow = el && el.querySelector('.heading');
  if (!arrow) return;
  el.classList.add('has-heading');
  arrow.style.transform = `rotate(${state.headingCss.toFixed(1)}deg)`;
}

function onFixError(err) {
  const msg = err.code === err.PERMISSION_DENIED
    ? 'Location permission denied — progress needs GPS'
    : err.code === err.POSITION_UNAVAILABLE
      ? 'No GPS signal yet — canopy blocks it in places'
      : 'Waiting for GPS…';
  const el = $('#hud-status');
  el.textContent = msg;
  el.className = err.code === err.PERMISSION_DENIED ? 'warn' : '';
}

/** Write a distance into a stat tile, with the unit in a smaller span. */
function setStat(sel, metres) {
  const { value, unit } = splitDistance(metres);
  $(sel).innerHTML = `${escapeHtml(value)}${unit ? `<i>${unit}</i>` : ''}`;
}

function renderProgress(p, accuracy) {
  const status = $('#hud-status');

  if (!p) {
    status.textContent = 'Waiting for GPS…';
    setStat('#st-done', 0);
    setStat('#st-left', state.route.total);
    $('#st-pct').textContent = '0%';
    $('#st-next').textContent = '–';
    return;
  }

  setStat('#st-done', p.along);
  setStat('#st-left', p.remaining);
  $('#st-pct').textContent = `${Math.round(p.fraction * 100)}%`;

  const next = state.checkpoints.find(cp => cp.along > p.along + 5);
  if (next) {
    setStat('#st-next', next.along - p.along);
    $('#st-next-l').textContent = next.id === 'finish' ? 'to finish' : `to ${shortName(next.name)}`;
    $('#st-next-l').title = next.name;
  } else {
    $('#st-next').textContent = 'Done';
    $('#st-next-l').textContent = 'finished';
  }

  $('#bar-fill').style.width = `${(p.fraction * 100).toFixed(2)}%`;
  const me = $('#bar-me');
  me.classList.add('on');
  me.style.left = `${(p.fraction * 100).toFixed(2)}%`;

  state.doneLine.setLatLngs(walkedPath(p.along));

  const minimised = $('#hud-body').hidden;
  if (p.restored) {
    status.textContent = `Resumed at ${formatDistance(p.along)} · waiting for GPS…`;
    status.className = '';
  } else if (!p.onRoute) {
    status.textContent =
      `Off route — ${formatDistance(p.offset)} from the path · progress reset to the start`;
    status.className = 'warn';
  } else {
    const parts = [];
    // minimised, the status line is the only place the numbers can live
    if (minimised) parts.push(`${formatDistance(p.remaining)} to finish`,
      `${Math.round(p.fraction * 100)}%`);
    if (p.eta) parts.push(`${formatDuration(p.eta)} at this pace`);
    else if (p.speed) parts.push(`${(p.speed * 3.6).toFixed(1)} km/h avg`);
    else if (!minimised && accuracy) parts.push(`GPS accurate to ${Math.round(accuracy)} m`);
    if (state.gpsMode === 'poll') parts.push(`GPS every ${SAVER_POLL_MS / 1000} s`);
    status.textContent = parts.join(' · ') || 'On route';
    status.className = 'live';
  }
}

/** Route vertices up to `along`, so the walked portion can be drawn. */
function walkedPath(along) {
  const out = [];
  const { points, cumulative } = state.route;
  for (let i = 0; i < points.length; i++) {
    if (cumulative[i] <= along) out.push([points[i][0], points[i][1]]);
    else break;
  }
  out.push(state.route.atDistance(along));
  return out;
}

// ── weather ──────────────────────────────────────────────────────────
function startWeather() {
  const cached = cachedWeather();
  if (cached) renderWeather({ ...cached, stale: true });
  refreshWeather(false);
  state.weatherTimer = setInterval(() => refreshWeather(false), WEATHER_REFRESH_MS);
}

async function refreshWeather(manual) {
  const btn = $('#wx-refresh');
  clearTimeout(state.wxRetry);
  btn.disabled = true;
  try {
    const centre = state.lastFix
      ? { lat: state.lastFix[0], lon: state.lastFix[1] }
      : centreOfRoute();
    // sample the route so the nowcast covers every area it passes through
    const samples = [0, 0.25, 0.5, 0.75].map(f => state.route.atDistance(f * state.route.total));
    const model = await loadWeather(centre, samples);
    renderWeather(model);
    state.wxFailures = 0;
    if (manual) toast('Weather updated');
  } catch (err) {
    console.warn('weather', err);
    const cached = cachedWeather();
    if (cached) renderWeather({ ...cached, stale: true });
    else $('#wx-note').textContent = 'Weather unavailable — retrying…';
    if (manual) toast('Could not reach the NEA feed');

    // Come back quickly rather than waiting out the whole 5-minute cycle: a
    // failed load is usually a transient blip, and a blank card at the start
    // line is exactly when it matters most.
    state.wxFailures = (state.wxFailures || 0) + 1;
    const wait = Math.min(60000, 5000 * state.wxFailures);
    state.wxRetry = setTimeout(() => refreshWeather(false), wait);
  } finally {
    btn.disabled = false;
  }
}

function centreOfRoute() {
  const b = state.route.doc.bounds;
  return { lat: (b.minLat + b.maxLat) / 2, lon: (b.minLon + b.maxLon) / 2 };
}

function weatherOpen() {
  return $('#wx-toggle').getAttribute('aria-expanded') === 'true';
}

function setWeatherOpen(open, initial = false) {
  $('#wx-toggle').setAttribute('aria-expanded', String(open));
  $('#wx-body').hidden = !open;
  // On a phone the open forecast is a bottom sheet covering most of the map, so
  // the control stack steps aside rather than sitting uselessly behind it.
  document.body.classList.toggle('wx-open', open);
  if (open) closeLayers();
  if (!initial) localStorage.setItem('ums-wx-open', open ? '1' : '0');
}

function closeLayers() {
  $('#layers').hidden = true;
  $('#btn-layers').setAttribute('aria-pressed', 'false');
}

function renderWeather(m) {
  const now = m.now;
  const risk = m.risk || { level: 'ok', alerts: [] };

  // ── summary bar: the part that stays on screen when collapsed ──
  $('#weather').dataset.risk = risk.level;
  $('#wx-bar-ico').innerHTML = weatherIcon(now.code);
  $('#wx-bar-temp').textContent = now.tempC != null ? `${now.tempC.toFixed(1)}°C` : '–';
  $('#wx-bar-txt').textContent = now.text;

  const aq = [];
  if (m.air.psi != null) aq.push(`PSI ${m.air.psi}`);
  if (m.air.pm25 != null) aq.push(`PM2.5 ${m.air.pm25}`);
  $('#wx-bar-aq').textContent = aq.join(' · ');

  // The banner carries only the single most serious warning, so it stays one or
  // two lines on a phone. The rest are listed in the expanded panel.
  const alert = $('#wx-alert');
  if (risk.alerts.length) {
    const [lead, ...rest] = risk.alerts;
    alert.innerHTML =
      `${risk.level === 'severe' ? '⚠ ' : ''}${escapeHtml(lead.text)}` +
      (rest.length ? ` <span class="wx-more">+${rest.length} more</span>` : '');
    alert.title = risk.alerts.map(a => a.text).join('\n');
    alert.hidden = false;
  } else {
    alert.hidden = true;
    alert.removeAttribute('title');
  }
  state.measurePanels?.();

  // ── forecast cards ──
  $('#wx-cards').innerHTML = [
    `<div class="wx-card now">
       <span class="wx-when">Now</span>
       ${weatherIcon(now.code)}
       <span class="wx-temp">${now.tempC != null ? `${now.tempC.toFixed(1)}°C` : '–'}</span>
       <span class="wx-desc">${escapeHtml(now.text)}</span>
     </div>`,
    ...m.slots.map(s => `
      <div class="wx-card">
        <span class="wx-when">${s.label}</span>
        ${weatherIcon(s.code)}
        <span class="wx-temp">${s.tempC != null ? `~${Math.round(s.tempC)}°C` : '–'}</span>
        <span class="wx-desc">${escapeHtml(s.text)}</span>
      </div>`),
  ].join('');

  // ── air quality tiles ──
  const arrow = { rising: '↑', easing: '↓', steady: '→' }[m.air.trend] || '';
  const tile = (key, value, band, sub) => {
    if (value == null) return '';
    return `<div class="wx-aq" data-level="${band ? band.level : 'ok'}">
      <span class="wx-aq-k">${key}</span>
      <span class="wx-aq-v">${value}</span>
      <span class="wx-aq-b">${escapeHtml([band?.label, sub].filter(Boolean).join(' · '))}</span>
    </div>`;
  };
  $('#wx-air').innerHTML = [
    tile('PSI 24h', m.air.psi, psiBand(m.air.psi), ''),
    tile('PM2.5 1h', m.air.pm25, pm25Band(m.air.pm25),
      m.air.trend ? `${arrow} ${m.air.trend}` : ''),
    // UV reads 0 all night; the tile only earns its place in daylight
    m.air.uv ? tile('UV index', m.air.uv, uvBand(m.air.uv), '') : '',
  ].join('') || '<p class="fineprint">Air-quality data unavailable.</p>';

  // ── every warning, in full, where there is room for them ──
  const list = $('#wx-alerts');
  if (risk.alerts.length > 1) {
    list.innerHTML = risk.alerts
      .map(a => `<li data-level="${a.level}">${escapeHtml(a.text)}</li>`).join('');
    list.hidden = false;
  } else {
    list.hidden = true;
  }

  // ── caption ──
  const bits = [];
  if (now.humidity != null) bits.push(`${Math.round(now.humidity)}% RH`);
  if (now.windKt != null) bits.push(`wind ${Math.round(now.windKt * 1.852)} km/h`);
  if (now.rainfallMm) bits.push(`rain ${now.rainfallMm} mm`);
  if (m.day.low != null) bits.push(`today ${m.day.low}–${m.day.high}°C`);
  const when = now.observedAt
    ? new Date(now.observedAt).toLocaleTimeString('en-SG',
      { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Singapore' })
    : '';
  bits.push(`NEA ${when || 'live'}`);
  if (m.air.stale) bits.push('air quality from last reading');
  if (m.stale) bits.push('offline copy');

  const note = $('#wx-note');
  note.textContent = bits.join(' · ');
  const areas = now.areas?.length ? now.areas.join(', ') : 'the route';
  note.title =
    `Nowcast for ${areas} (${now.validPeriod || 'next 2 hours'}). ` +
    `+2/4/6 h conditions come from NEA's 24-hour forecast for the ${m.day.region} region; ` +
    `their temperatures are estimated by tracking the current reading along today's ` +
    `${m.day.low}\u2013${m.day.high}\u00b0C forecast range. ` +
    `PSI and PM2.5 are the ${m.air.region} region readings; NEA publishes no PSI forecast, ` +
    `so the trend compares the 1-hour PM2.5 against its own 24-hour average.`;
}

// ── misc ─────────────────────────────────────────────────────────────
let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), 2600);
}

/** Squeeze a landmark name into the narrow "next checkpoint" label. */
function shortName(name) {
  const trimmed = name
    .replace(/^(The|HSBC)\s+/i, '')
    .replace(/\s+(Boardwalk|Ruins|Memorial|Station|Park)$/i, '');
  return trimmed.length > 15 ? `${trimmed.slice(0, 14)}…` : trimmed;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // Service workers need a secure context: HTTPS, or any loopback address.
  if (!window.isSecureContext) return;
  navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW', err));
}
