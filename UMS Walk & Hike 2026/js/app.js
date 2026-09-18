// UMS Walk & Hike 2026 — interactive route map, progress tracker and weather.

import { Route, ProgressTracker, formatDistance, splitDistance, formatDuration } from './geo.js';
import { CATEGORY, poiIcon, legendIcon, checkpointIcon, clusterIcon, meIcon, weatherIcon } from './icons.js';
import { loadWeather, cachedWeather, psiBand, pm25Band, uvBand } from './weather.js';

const $ = sel => document.querySelector(sel);

// Panning and zooming are confined to the route plus this much breathing room.
const CORRIDOR_M = 2000;
// how many zoom levels beyond the corridor fit the user may zoom out
const ZOOM_OUT_SLACK = 1;
const FOLLOW_INTERVAL_MS = 1000;
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
};

// ── base maps ────────────────────────────────────────────────────────
const ONEMAP_ATTR =
  'Map data &copy; <a href="https://www.onemap.gov.sg/">OneMap</a> / Singapore Land Authority';
const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

const BASEMAPS = [
  {
    id: 'onemap',
    name: 'Singapore (OneMap)',
    note: 'Official SLA national basemap — shows park connectors, trails and nature-reserve paths.',
    swatch: '#e8e3d8',
    make: () => L.tileLayer('https://www.onemap.gov.sg/maps/tiles/Default/{z}/{x}/{y}.png', {
      minZoom: 11, maxZoom: 19, attribution: ONEMAP_ATTR,
    }),
  },
  {
    id: 'trail',
    name: 'Trail map',
    note: 'Muted OneMap base with every footpath and trail in the corridor drawn on top, aligned 1:1 with the ground.',
    swatch: '#cfd6cd',
    trails: true,
    make: () => L.tileLayer('https://www.onemap.gov.sg/maps/tiles/Grey/{z}/{x}/{y}.png', {
      minZoom: 11, maxZoom: 19, attribution: ONEMAP_ATTR,
    }),
  },
  {
    id: 'satellite',
    name: 'Satellite',
    note: 'Esri World Imagery. Canopy hides most trail surface inside the reserve.',
    swatch: '#3f5340',
    make: () => L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: 19, attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics' }),
  },
  {
    id: 'osm',
    name: 'Street (OSM)',
    note: 'OpenStreetMap standard — the same data the markers come from.',
    swatch: '#f2efe9',
    make: () => L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: OSM_ATTR,
    }),
  },
];

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
  renderProgress(null);

  startLocating();
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

  for (const spec of BASEMAPS) state.baseLayers[spec.id] = spec.make();

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
 * Photo for a checkpoint popup, with the credit its licence requires.
 *
 * Loaded lazily and only when the popup opens, so the images cost nothing until
 * someone actually taps a checkpoint.
 */
function photoHtml(id) {
  const photo = state.photos?.[id];
  if (!photo) return '';
  return `<figure class="pop-photo">
    <img src="${escapeHtml(photo.file)}" alt="" decoding="async">
    <figcaption>${escapeHtml(photo.credit)}${photo.licence ? ` · ${escapeHtml(photo.licence)}` : ''}</figcaption>
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
        `<div class="pop-t">${escapeHtml(p.name === meta.label ? meta.label : p.name)}</div>` +
        (p.detail ? `<div class="pop-d">${escapeHtml(p.detail)}</div>` : '') +
        (p.note ? `<div class="pop-n">${escapeHtml(p.note)}</div>` : '') +
        `<div class="pop-m">km ${(p.along / 1000).toFixed(2)} on route · ${p.offset} m off the path</div>`,
        { maxWidth: p.note ? 270 : 300 }));

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
  $('#basemaps').innerHTML = BASEMAPS.map(spec =>
    `<button type="button" role="radio" data-id="${spec.id}" aria-checked="false">
       <span class="sw" style="background:${spec.swatch}"></span>${spec.name}
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
    <label><input type="checkbox" id="chk-follow">
      <span class="n">Follow me</span><span class="c">1 s</span></label>`;

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
    if (!document.hidden) refreshWeather(false);
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
function startLocating() {
  if (!('geolocation' in navigator)) {
    $('#hud-status').textContent = 'This device has no location support';
    return;
  }
  state.watchId = navigator.geolocation.watchPosition(onFix, onFixError, {
    enableHighAccuracy: true,
    maximumAge: 2000,
    timeout: 20000,
  });
}

function onFix(pos) {
  const { latitude: lat, longitude: lon, accuracy } = pos.coords;
  state.lastFix = [lat, lon];

  if (!state.marker) {
    state.marker = L.marker([lat, lon], { icon: meIcon(), zIndexOffset: 1000, interactive: false })
      .addTo(state.map);
    state.accuracyRing = L.circle([lat, lon], {
      radius: accuracy, color: '#3b8cff', weight: 1, fillColor: '#3b8cff', fillOpacity: 0.1, interactive: false,
    }).addTo(state.map);
  } else {
    state.marker.setLatLng([lat, lon]);
    state.accuracyRing.setLatLng([lat, lon]).setRadius(accuracy);
  }

  const progress = state.tracker.update(lat, lon, pos.timestamp || Date.now());
  state.lastProgress = progress;
  state.lastAccuracy = accuracy;
  renderProgress(progress, accuracy);
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
  if (!p.onRoute) {
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
