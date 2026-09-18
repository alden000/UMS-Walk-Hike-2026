// UMS Walk & Hike 2026 — interactive route map, progress tracker and weather.

import { Route, ProgressTracker, formatDistance, formatDuration } from './geo.js';
import { CATEGORY, poiIcon, legendIcon, checkpointIcon, meIcon, weatherIcon } from './icons.js';
import { loadWeather, cachedWeather } from './weather.js';

const $ = sel => document.querySelector(sel);

// Panning and zooming are confined to the route plus this much breathing room.
const CORRIDOR_M = 1000;
const FOLLOW_INTERVAL_MS = 1000;
const WEATHER_REFRESH_MS = 10 * 60 * 1000;

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
  const [routeDoc, poiDoc, cpDoc, trailDoc] = await Promise.all([
    fetchJSON('data/route.json'),
    fetchJSON('data/pois.json'),
    fetchJSON('data/checkpoints.json'),
    fetchJSON('data/trails.json').catch(() => ({ ways: [] })),
  ]);

  state.route = new Route(routeDoc);
  state.tracker = new ProgressTracker(state.route);
  state.pois = poiDoc.categories || {};
  state.checkpoints = cpDoc.checkpoints || [];

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
  // 1 km of slack around the route, converted to degrees at this latitude.
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
  applyMinZoom();
  map.on('resize', applyMinZoom);
  // panning by hand means the walker wants to look elsewhere; zooming does not
  map.on('dragstart', () => {
    if (state.following && !state.programmaticMove) setFollowing(false, true);
  });

  setBasemap(localStorage.getItem('ums-basemap') || 'onemap');
}

/** Keep the whole allowed area no smaller than the viewport, so the wall holds. */
function applyMinZoom() {
  const z = state.map.getBoundsZoom(state.limitBounds, true);
  state.map.setMinZoom(Math.max(11, Math.floor(z * 4) / 4));
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
        `<div class="pop-t">${escapeHtml(cp.name)}</div>` +
        (cp.note ? `<div class="pop-d">${escapeHtml(cp.note)}</div>` : '') +
        `<div class="pop-m">${formatDistance(cp.along)} in · ${formatDistance(remaining)} to finish</div>`)
      .addTo(group);
  });
  state.layers.checkpoints = group.addTo(state.map);

  const ticks = $('#bar-ticks');
  ticks.innerHTML = state.checkpoints
    .filter(cp => cp.along > 0 && cp.along < state.route.total)
    .map(cp => `<i style="left:${(cp.along / state.route.total * 100).toFixed(2)}%"></i>`)
    .join('');

  $('#hud-note').textContent =
    `${(state.route.total / 1000).toFixed(2)} km loop · ${state.checkpoints.length - 2} checkpoints · ` +
    `${state.route.doc.elevation.gain} m ascent`;
}

function buildPois() {
  for (const [cat, meta] of Object.entries(CATEGORY)) {
    const items = state.pois[cat] || [];
    const group = L.layerGroup();
    for (const p of items) {
      L.marker([p.lat, p.lon], { icon: poiIcon(cat), zIndexOffset: cat === 'aed' ? 500 : 0 })
        .bindPopup(
          `<div class="pop-t">${escapeHtml(p.name === meta.label ? meta.label : p.name)}</div>` +
          (p.detail ? `<div class="pop-d">${escapeHtml(p.detail)}</div>` : '') +
          `<div class="pop-m">km ${(p.along / 1000).toFixed(2)} on route · ${p.offset} m off the path</div>`)
        .addTo(group);
    }
    state.layers[cat] = group;
    // shelters are numerous; leave them off until asked for
    if (cat !== 'shelter') group.addTo(state.map);
  }
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
      <input type="checkbox" data-layer="${cat}" ${cat === 'shelter' ? '' : 'checked'}>
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
      const layer = state.layers[box.dataset.layer];
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
    $('#layers').hidden = !open;
    layersBtn.setAttribute('aria-pressed', String(open));
  });

  const hudToggle = $('#hud-toggle');
  hudToggle.addEventListener('click', () => {
    const open = hudToggle.getAttribute('aria-expanded') === 'true';
    hudToggle.setAttribute('aria-expanded', String(!open));
    $('#hud-body').hidden = open;
  });

  // The control stack lives in the band between the HUD and the weather panel.
  // Both change height with their content, so measure them and publish the
  // results as CSS variables.
  const measure = () => {
    const root = document.documentElement.style;
    root.setProperty('--wx-h', `${Math.round($('#weather').offsetHeight)}px`);
    root.setProperty('--hud-h', `${Math.round($('#hud').offsetHeight)}px`);
  };
  measure();
  if ('ResizeObserver' in window) {
    const ro = new ResizeObserver(measure);
    ro.observe($('#weather'));
    ro.observe($('#hud'));
  } else {
    window.addEventListener('resize', measure);
  }

  $('#wx-refresh').addEventListener('click', () => refreshWeather(true));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshWeather(false);
  });
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

function renderProgress(p, accuracy) {
  const status = $('#hud-status');

  if (!p) {
    status.textContent = 'Waiting for GPS…';
    $('#st-done').textContent = '0.00 km';
    $('#st-left').textContent = formatDistance(state.route.total);
    $('#st-pct').textContent = '0%';
    $('#st-next').textContent = '–';
    return;
  }

  $('#st-done').textContent = formatDistance(p.along);
  $('#st-left').textContent = formatDistance(p.remaining);
  $('#st-pct').textContent = `${Math.round(p.fraction * 100)}%`;

  const next = state.checkpoints.find(cp => cp.along > p.along + 5);
  if (next) {
    $('#st-next').textContent = formatDistance(next.along - p.along);
    $('#st-next-l').textContent = next.id === 'finish' ? 'to finish' : `to ${next.name.replace('Checkpoint ', 'CP ')}`;
  } else {
    $('#st-next').textContent = 'Done';
    $('#st-next-l').textContent = 'finished';
  }

  $('#bar-fill').style.width = `${(p.fraction * 100).toFixed(2)}%`;
  const me = $('#bar-me');
  me.classList.add('on');
  me.style.left = `${(p.fraction * 100).toFixed(2)}%`;

  state.doneLine.setLatLngs(walkedPath(p.along));

  if (!p.onRoute) {
    status.textContent = `Off route — ${formatDistance(p.offset)} from the path`;
    status.className = 'warn';
  } else {
    const parts = [];
    if (p.eta) parts.push(`${formatDuration(p.eta)} to finish at this pace`);
    if (p.speed) parts.push(`${(p.speed * 3.6).toFixed(1)} km/h avg`);
    if (!parts.length && accuracy) parts.push(`GPS accurate to ${Math.round(accuracy)} m`);
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
  btn.disabled = true;
  try {
    const centre = state.lastFix
      ? { lat: state.lastFix[0], lon: state.lastFix[1] }
      : centreOfRoute();
    // sample the route so the nowcast covers every area it passes through
    const samples = [0, 0.25, 0.5, 0.75].map(f => state.route.atDistance(f * state.route.total));
    const model = await loadWeather(centre, samples);
    renderWeather(model);
    if (manual) toast('Weather updated');
  } catch (err) {
    console.warn('weather', err);
    const cached = cachedWeather();
    if (cached) renderWeather({ ...cached, stale: true });
    else $('#wx-note').textContent = 'Weather unavailable — no connection to NEA.';
    if (manual) toast('Could not reach the NEA feed');
  } finally {
    btn.disabled = false;
  }
}

function centreOfRoute() {
  const b = state.route.doc.bounds;
  return { lat: (b.minLat + b.maxLat) / 2, lon: (b.minLon + b.maxLon) / 2 };
}

function renderWeather(m) {
  const now = m.now;
  const cards = [
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
  ];
  $('#wx-cards').innerHTML = cards.join('');

  const bits = [];
  if (now.humidity != null) bits.push(`${Math.round(now.humidity)}% RH`);
  if (now.windKt != null) bits.push(`wind ${Math.round(now.windKt * 1.852)} km/h`);
  if (now.rainfallMm) bits.push(`rain ${now.rainfallMm} mm`);
  if (m.day.low != null) bits.push(`today ${m.day.low}–${m.day.high}°C`);

  const when = now.observedAt
    ? new Date(now.observedAt).toLocaleTimeString('en-SG', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Singapore' })
    : '';
  bits.push(`NEA ${when || 'live'}`);
  if (m.stale) bits.push('offline copy');
  bits.push('+2/4/6 h temps estimated');

  const note = $('#wx-note');
  note.textContent = bits.join(' · ');
  const areas = now.areas?.length ? now.areas.join(', ') : 'the route';
  note.title =
    `NEA nowcast for ${areas} (${now.validPeriod || 'next 2 hours'}). ` +
    `+2/4/6 h conditions come from NEA's 24-hour forecast for the ${m.day.region} region; ` +
    `their temperatures are estimated by tracking the current reading along today's ` +
    `${m.day.low}–${m.day.high}°C forecast range.`;
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
