// Weather and air quality for the route, from NEA's official real-time APIs on
// data.gov.sg.
//
//   two-hr-forecast          nowcast per forecast area (47 areas island-wide)
//   twenty-four-hr-forecast  period forecasts per region + the day's range
//   air-temperature          live station observations (deg C)
//   relative-humidity        live station observations (%)
//   rainfall                 live station observations (mm in the last 5 min)
//   wind-speed               live station observations (knots)
//   psi                      24-hour PSI + sub-indices, per region
//   pm25                     1-hour PM2.5, per region
//   uv                       UV index (daylight hours only)
//
// All are open, keyless and CORS-enabled. Docs: https://data.gov.sg/datasets

import { haversine } from './geo.js';

const BASE = 'https://api-open.data.gov.sg/v2/real-time/api';
const CACHE_KEY = 'ums-wx-cache-v2';
const CACHE_MAX_AGE = 30 * 60 * 1000;   // show stale data for up to 30 min offline

// Forecast codes that mean lightning is possible. NEA's public API has no
// lightning-strike feed (the `lightning` endpoint is not open), so these codes
// are the official signal available.
const STORM_CODES = new Set(['TL', 'HT', 'HG']);
const HEAVY_CODES = new Set(['HR', 'HS', 'SR', 'SK']);
const WET_CODES = new Set(['RA', 'SH', 'PS', 'LS', 'LR', 'DR', 'WR', 'WS']);

/** NEA forecast wording -> the icon code used by the 24-hour forecast API. */
function codeFromText(text = '') {
  const t = text.toLowerCase();
  if (t.includes('gusty')) return 'HG';
  if (t.includes('heavy thundery')) return 'HT';
  if (t.includes('thundery')) return 'TL';
  if (t.includes('heavy rain')) return 'HR';
  if (t.includes('heavy showers')) return 'HS';
  if (t.includes('moderate rain')) return 'RA';
  if (t.includes('light rain')) return 'LR';
  if (t.includes('light showers')) return 'LS';
  if (t.includes('passing showers')) return 'PS';
  if (t.includes('showers')) return 'SH';
  if (t.includes('drizzle')) return 'DR';
  if (t.includes('rain')) return 'RA';
  if (t.includes('slightly hazy')) return 'LH';
  if (t.includes('hazy') || t.includes('haze')) return 'HZ';
  if (t.includes('mist')) return 'BR';
  if (t.includes('fog')) return 'FG';
  if (t.includes('windy')) return 'WD';
  if (t.includes('strong winds')) return 'SW';
  if (t.includes('overcast')) return 'OC';
  if (t.includes('cloudy') && t.includes('partly')) return t.includes('night') ? 'PN' : 'PC';
  if (t.includes('cloudy')) return 'CL';
  if (t.includes('fair') || t.includes('sunny')) return t.includes('night') ? 'FN' : 'FA';
  return 'CL';
}

async function getJSON(path, signal) {
  const res = await fetch(`${BASE}/${path}`, { signal, cache: 'no-store' });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  const body = await res.json();
  if (body.code !== 0 && body.code !== undefined && body.errorMsg) throw new Error(body.errorMsg);
  return body.data;
}

/** Value from the station nearest to (lat, lon), or null if none reported. */
function nearestReading(payload, lat, lon) {
  if (!payload) return null;
  const stations = payload.stations || [];
  const reading = (payload.readings || [])[0];
  if (!reading) return null;
  const byId = new Map(stations.map(s => [s.id, s]));
  let best = null;
  for (const entry of reading.data) {
    const station = byId.get(entry.stationId);
    if (!station || entry.value == null) continue;
    const d = haversine(lat, lon, station.location.latitude, station.location.longitude);
    if (!best || d < best.d) best = { d, value: entry.value, station: station.name };
  }
  return best && { ...best, at: reading.timestamp, unit: payload.readingUnit };
}

/** The NEA forecast areas closest to a handful of points along the route. */
function areasAlongRoute(areaMetadata, samples) {
  const picked = new Set();
  for (const [lat, lon] of samples) {
    let best = null;
    for (const a of areaMetadata) {
      const d = haversine(lat, lon, a.label_location.latitude, a.label_location.longitude);
      if (!best || d < best.d) best = { d, name: a.name };
    }
    if (best) picked.add(best.name);
  }
  return [...picked];
}

/** Singapore's five forecast regions, from a point. */
function regionFor(lat, lon) {
  if (lat > 1.38) return 'north';
  if (lat < 1.29) return 'south';
  if (lon > 103.88) return 'east';
  if (lon < 103.72) return 'west';
  return 'central';
}

// ── air quality bands (NEA) ──────────────────────────────────────────
export function psiBand(psi) {
  if (psi == null) return null;
  if (psi <= 50) return { label: 'Good', level: 'ok' };
  if (psi <= 100) return { label: 'Moderate', level: 'warn' };
  if (psi <= 200) return { label: 'Unhealthy', level: 'severe' };
  if (psi <= 300) return { label: 'Very unhealthy', level: 'severe' };
  return { label: 'Hazardous', level: 'severe' };
}

export function pm25Band(pm) {
  if (pm == null) return null;
  if (pm <= 55) return { label: 'Normal', level: 'ok' };
  if (pm <= 150) return { label: 'Elevated', level: 'warn' };
  if (pm <= 250) return { label: 'High', level: 'severe' };
  return { label: 'Very high', level: 'severe' };
}

export function uvBand(uv) {
  if (uv == null) return null;
  if (uv <= 2) return { label: 'Low', level: 'ok' };
  if (uv <= 5) return { label: 'Moderate', level: 'ok' };
  if (uv <= 7) return { label: 'High', level: 'warn' };
  if (uv <= 10) return { label: 'Very high', level: 'warn' };
  return { label: 'Extreme', level: 'severe' };
}

/**
 * Turn the forecast and air-quality readings into a single walk-safety verdict.
 *
 * Lightning outranks everything: on an exposed boardwalk or an observation
 * tower it is the one hazard that kills, so a thundery-shower code anywhere in
 * the next two hours is surfaced as severe.
 */
function assessRisk(nowCode, slots, psi, pm25, uv) {
  const alerts = [];
  const soon = slots.filter(s => s.hoursAhead <= 2).map(s => s.code);
  const later = slots.filter(s => s.hoursAhead > 2).map(s => s.code);

  if (STORM_CODES.has(nowCode) || soon.some(c => STORM_CODES.has(c))) {
    alerts.push({ level: 'severe', text: 'Lightning risk — thundery showers now or within 2 h', key: 'storm' });
  } else if (later.some(c => STORM_CODES.has(c))) {
    alerts.push({ level: 'warn', text: 'Thundery showers forecast later today', key: 'storm-later' });
  }

  if (HEAVY_CODES.has(nowCode)) {
    alerts.push({ level: 'severe', text: 'Heavy rain — trails and boardwalks will be slippery', key: 'heavy' });
  } else if (soon.some(c => HEAVY_CODES.has(c))) {
    alerts.push({ level: 'warn', text: 'Heavy rain expected within 2 h', key: 'heavy-soon' });
  } else if (WET_CODES.has(nowCode) || soon.some(c => WET_CODES.has(c))) {
    alerts.push({ level: 'warn', text: 'Showers about — expect wet boardwalks', key: 'wet' });
  }

  const pb = psiBand(psi);
  if (pb && pb.level !== 'ok') {
    alerts.push({
      level: pb.level,
      text: `Haze — PSI ${psi} (${pb.label.toLowerCase()})`,
      key: 'psi',
    });
  }
  const mb = pm25Band(pm25);
  if (mb && mb.level === 'severe') {
    alerts.push({ level: 'severe', text: `PM2.5 ${pm25} µg/m³ (${mb.label.toLowerCase()})`, key: 'pm25' });
  }
  const ub = uvBand(uv);
  if (ub && ub.level !== 'ok') {
    alerts.push({ level: ub.level, text: `UV index ${uv} (${ub.label.toLowerCase()})`, key: 'uv' });
  }

  const level = alerts.some(a => a.level === 'severe') ? 'severe'
    : alerts.length ? 'warn' : 'ok';
  // most serious first, so the summary bar shows the one that matters
  alerts.sort((a, b) => (b.level === 'severe') - (a.level === 'severe'));
  return { level, alerts };
}

/**
 * Estimate the temperature `hoursAhead` from now.
 *
 * NEA publishes a daily high/low rather than an hourly temperature forecast, so
 * this walks the current observation along a standard diurnal curve bounded by
 * that forecast range. Flagged as an estimate in the UI.
 */
function estimateTemp(nowC, hoursAhead, low, high, now = new Date()) {
  if (nowC == null) return null;
  if (low == null || high == null) return nowC;
  const sgHour = Number(now.toLocaleString('en-GB', { timeZone: 'Asia/Singapore', hour: '2-digit', hour12: false }))
    + now.getMinutes() / 60;
  // Singapore's daily minimum sits near 06:00 and the maximum near 14:00.
  const shape = h => {
    const t = ((h % 24) + 24) % 24;
    return t >= 6 && t <= 14
      ? 0.5 - 0.5 * Math.cos(((t - 6) / 8) * Math.PI)
      : 0.5 + 0.5 * Math.cos(((((t - 14) + 24) % 24) / 16) * Math.PI);
  };
  const delta = (shape(sgHour + hoursAhead) - shape(sgHour)) * (high - low);
  return Math.max(low - 1, Math.min(high + 1, nowC + delta));
}

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw);
    if (Date.now() - cached.fetchedAt > CACHE_MAX_AGE) return null;
    return cached;
  } catch { return null; }
}

function writeCache(model) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(model)); } catch { /* quota / private mode */ }
}

/**
 * Build the weather + air-quality model for the route.
 *
 * @param {{lat:number, lon:number}} at        where to read live conditions (walker, or route centre)
 * @param {Array<[number,number]>}   samples   points along the route, for area coverage
 */
export async function loadWeather(at, samples, { signal } = {}) {
  const [twoHr, dayFc, temp, humidity, rain, wind, psiData, pmData, uvData] = await Promise.all([
    getJSON('two-hr-forecast', signal).catch(() => null),
    getJSON('twenty-four-hr-forecast', signal).catch(() => null),
    getJSON('air-temperature', signal).catch(() => null),
    getJSON('relative-humidity', signal).catch(() => null),
    getJSON('rainfall', signal).catch(() => null),
    getJSON('wind-speed', signal).catch(() => null),
    getJSON('psi', signal).catch(() => null),
    getJSON('pm25', signal).catch(() => null),
    getJSON('uv', signal).catch(() => null),
  ]);

  if (!twoHr && !dayFc && !temp) {
    const cached = readCache();
    if (cached) return { ...cached, stale: true };
    throw new Error('No weather data available');
  }

  const region = regionFor(at.lat, at.lon);
  const tempNow = nearestReading(temp, at.lat, at.lon);
  const humidityNow = nearestReading(humidity, at.lat, at.lon);
  const rainNow = nearestReading(rain, at.lat, at.lon);
  const windNow = nearestReading(wind, at.lat, at.lon);

  // ── now: nowcast condition for the areas the route passes through ──
  const item = twoHr?.items?.[0];
  const areaNames = twoHr ? areasAlongRoute(twoHr.area_metadata, samples) : [];
  const areaForecasts = (item?.forecasts || []).filter(f => areaNames.includes(f.area));
  // worst (wettest) condition wins, so the card warns rather than reassures
  const severity = c => ['FA', 'SU', 'FN', 'PC', 'PN', 'CL', 'OC', 'BR', 'FG', 'HZ', 'LH', 'WD', 'SW',
    'DR', 'LR', 'LS', 'PS', 'SH', 'RA', 'HS', 'HR', 'TL', 'HT', 'HG'].indexOf(c);
  const nowcast = areaForecasts
    .map(f => ({ area: f.area, text: f.forecast, code: codeFromText(f.forecast) }))
    .sort((a, b) => severity(b.code) - severity(a.code))[0];

  // ── future slots from the 24-hour forecast ──
  const record = dayFc?.records?.[0];
  const low = record?.general?.temperature?.low ?? null;
  const high = record?.general?.temperature?.high ?? null;

  const slots = [2, 4, 6].map(h => {
    const when = new Date(Date.now() + h * 3600 * 1000);
    const period = (record?.periods || []).find(p =>
      when >= new Date(p.timePeriod.start) && when < new Date(p.timePeriod.end));
    const regional = period?.regions?.[region];
    // within the first two hours the nowcast is the better source
    const text = (h <= 2 && nowcast?.text) || regional?.text || record?.general?.forecast?.text || '—';
    return {
      label: `+${h}h`,
      hoursAhead: h,
      at: when.toISOString(),
      code: (h <= 2 && nowcast?.code) || regional?.code || codeFromText(text),
      text,
      tempC: estimateTemp(tempNow?.value ?? null, h, low, high),
      estimated: true,
    };
  });

  // ── air quality ──
  const psiReadings = psiData?.items?.[0]?.readings;
  const pmReadings = pmData?.items?.[0]?.readings;
  const psi = psiReadings?.psi_twenty_four_hourly?.[region] ?? null;
  const pm25 = pmReadings?.pm25_one_hourly?.[region] ?? null;
  const pm25Day = psiReadings?.pm25_twenty_four_hourly?.[region] ?? null;
  const uvIndex = uvData?.records?.[0]?.index?.[0]?.value ?? null;

  // Any one feed can fail on its own (a transient 5xx answers without CORS
  // headers, and coverage on the trail is patchy). Rather than blanking the
  // tile, fall back to the last good reading and say how old it is.
  const previous = readCache();
  const air = {
    psi, pm25, pm25Day, uv: uvIndex,
    region,
    updatedAt: psiData?.items?.[0]?.updatedTimestamp || pmData?.items?.[0]?.updatedTimestamp || null,
  };
  let airStale = false;
  if (previous?.air) {
    for (const key of ['psi', 'pm25', 'pm25Day', 'uv']) {
      if (air[key] == null && previous.air[key] != null) {
        air[key] = previous.air[key];
        airStale = true;
      }
    }
    if (!air.updatedAt) air.updatedAt = previous.air.updatedAt;
  }
  air.stale = airStale;

  // NEA publishes no PSI/PM2.5 forecast feed. Comparing the 1-hour PM2.5
  // against its own 24-hour average is the honest short-range signal: above it
  // the air is getting worse right now, below it the haze is clearing.
  if (air.pm25 != null && air.pm25Day != null) {
    const diff = air.pm25 - air.pm25Day;
    air.trend = Math.abs(diff) < 4 ? 'steady' : diff > 0 ? 'rising' : 'easing';
  } else {
    air.trend = null;
  }

  const nowCode = nowcast?.code || codeFromText(record?.general?.forecast?.text || '');
  const risk = assessRisk(nowCode, slots, air.psi, air.pm25, air.uv);

  const model = {
    fetchedAt: Date.now(),
    stale: false,
    risk,
    now: {
      code: nowCode,
      text: nowcast?.text || record?.general?.forecast?.text || 'No nowcast',
      tempC: tempNow?.value ?? null,
      tempStation: tempNow?.station || null,
      humidity: humidityNow?.value ?? null,
      rainfallMm: rainNow?.value ?? null,
      windKt: windNow?.value ?? null,
      observedAt: tempNow?.at || item?.timestamp || null,
      validPeriod: item?.valid_period?.text || '',
      areas: areaNames,
    },
    slots,
    air,
    day: {
      low, high,
      text: record?.general?.forecast?.text || '',
      region,
      validPeriod: record?.general?.validPeriod?.text || '',
    },
  };

  writeCache(model);
  return model;
}

export { readCache as cachedWeather };
