// Weather for the route, from NEA's official real-time APIs on data.gov.sg.
//
//   two-hr-forecast          nowcast per forecast area (47 areas island-wide)
//   twenty-four-hr-forecast  period forecasts per region + the day's range
//   air-temperature          live station observations (deg C)
//   relative-humidity        live station observations (%)
//   rainfall                 live station observations (mm in the last 5 min)
//   wind-speed               live station observations (knots)
//
// All are open, keyless and CORS-enabled. Docs: https://data.gov.sg/datasets

import { haversine } from './geo.js';

const BASE = 'https://api-open.data.gov.sg/v2/real-time/api';
const CACHE_KEY = 'ums-wx-cache-v1';
const CACHE_MAX_AGE = 30 * 60 * 1000;   // show stale data for up to 30 min offline

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
  const picked = new Map();
  for (const [lat, lon] of samples) {
    let best = null;
    for (const a of areaMetadata) {
      const d = haversine(lat, lon, a.label_location.latitude, a.label_location.longitude);
      if (!best || d < best.d) best = { d, name: a.name };
    }
    if (best && !picked.has(best.name)) picked.set(best.name, best.d);
  }
  return [...picked.keys()];
}

/** Singapore's five forecast regions, from a point. */
function regionFor(lat, lon) {
  if (lat > 1.38) return 'north';
  if (lat < 1.29) return 'south';
  if (lon > 103.88) return 'east';
  if (lon < 103.72) return 'west';
  return 'central';
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
 * Build the weather model for the route.
 *
 * @param {{lat:number, lon:number}} at        where to read live conditions (walker, or route centre)
 * @param {Array<[number,number]>}   samples   points along the route, for area coverage
 * @returns {Promise<object>} model with `now` and `slots` (+2h / +4h / +6h)
 */
export async function loadWeather(at, samples, { signal } = {}) {
  const [twoHr, dayFc, temp, humidity, rain, wind] = await Promise.all([
    getJSON('two-hr-forecast', signal).catch(() => null),
    getJSON('twenty-four-hr-forecast', signal).catch(() => null),
    getJSON('air-temperature', signal).catch(() => null),
    getJSON('relative-humidity', signal).catch(() => null),
    getJSON('rainfall', signal).catch(() => null),
    getJSON('wind-speed', signal).catch(() => null),
  ]);

  if (!twoHr && !dayFc && !temp) {
    const cached = readCache();
    if (cached) return { ...cached, stale: true };
    throw new Error('No weather data available');
  }

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
  const region = regionFor(at.lat, at.lon);
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
      at: when.toISOString(),
      code: (h <= 2 && nowcast?.code) || regional?.code || codeFromText(text),
      text,
      tempC: estimateTemp(tempNow?.value ?? null, h, low, high),
      estimated: true,
      period: period?.timePeriod?.text || record?.general?.validPeriod?.text || '',
    };
  });

  const model = {
    fetchedAt: Date.now(),
    stale: false,
    now: {
      code: nowcast?.code || codeFromText(record?.general?.forecast?.text || ''),
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
    day: {
      low, high,
      text: record?.general?.forecast?.text || '',
      humidity: record?.general?.relativeHumidity || null,
      wind: record?.general?.wind || null,
      region,
      validPeriod: record?.general?.validPeriod?.text || '',
    },
    sources: ['NEA / data.gov.sg'],
  };

  writeCache(model);
  return model;
}

export { readCache as cachedWeather };
