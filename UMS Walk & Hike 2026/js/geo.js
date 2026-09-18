// Route geometry: projecting a live position onto the route to work out how far
// along it we are, and how much is left.

const R_EARTH = 6371008.8;
const DEG = Math.PI / 180;

export function haversine(aLat, aLon, bLat, bLon) {
  const p1 = aLat * DEG, p2 = bLat * DEG;
  const dp = p2 - p1, dl = (bLon - aLon) * DEG;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(h));
}

export function formatDistance(m) {
  if (m == null || !isFinite(m)) return '–';
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 2 : 1)} km`;
}

/** Distance split into number and unit, so the unit can be set smaller. */
export function splitDistance(m) {
  if (m == null || !isFinite(m)) return { value: '–', unit: '' };
  if (m < 1000) return { value: String(Math.round(m)), unit: 'm' };
  return { value: (m / 1000).toFixed(m < 10000 ? 2 : 1), unit: 'km' };
}

export function formatDuration(sec) {
  if (sec == null || !isFinite(sec) || sec <= 0) return '–';
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m} min`;
}

/**
 * An indexed route. Coordinates are projected to a local metre grid once, so
 * per-fix work is a plain loop over segments — fast enough to run every second
 * on a phone for a route of this size (~430 points).
 */
export class Route {
  constructor(doc) {
    this.doc = doc;
    this.points = doc.points;                 // [[lat, lon, ele], …]
    this.cumulative = doc.cumulative;         // metres from start, per point
    this.total = doc.totalDistance;
    this.isLoop = !!doc.isLoop;

    const lat0 = (doc.bounds.minLat + doc.bounds.maxLat) / 2;
    this.mLat = 110574;
    this.mLon = 111320 * Math.cos(lat0 * DEG);
    this.xy = this.points.map(p => [p[1] * this.mLon, p[0] * this.mLat]);
  }

  latLngs() {
    return this.points.map(p => [p[0], p[1]]);
  }

  /**
   * Nearest point on the route to (lat, lon).
   *
   * `hintAlong` disambiguates a looping/doubling-back route: where two parts of
   * the route pass close together, prefer the candidate nearest to where the
   * walker already was. Without it, walking the MacRitchie loop makes progress
   * jump between the outbound and return legs.
   */
  project(lat, lon, hintAlong = null, hintWindow = 600) {
    const px = lon * this.mLon, py = lat * this.mLat;
    let best = null, bestHinted = null;

    for (let i = 0; i < this.xy.length - 1; i++) {
      const [ax, ay] = this.xy[i];
      const [bx, by] = this.xy[i + 1];
      const dx = bx - ax, dy = by - ay;
      const seg2 = dx * dx + dy * dy;
      let t = seg2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / seg2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const cx = ax + t * dx, cy = ay + t * dy;
      const d2 = (px - cx) ** 2 + (py - cy) ** 2;
      const along = this.cumulative[i] + t * (this.cumulative[i + 1] - this.cumulative[i]);
      const cand = { d2, along, lat: cy / this.mLat, lon: cx / this.mLon };

      if (!best || d2 < best.d2) best = cand;
      if (hintAlong != null && this._withinHint(along, hintAlong, hintWindow)) {
        if (!bestHinted || d2 < bestHinted.d2) bestHinted = cand;
      }
    }

    // Only trust the hinted match while it is a plausible fix (within ~120 m of
    // the route); otherwise fall back to the globally nearest point.
    const pick = (bestHinted && Math.sqrt(bestHinted.d2) < 120) ? bestHinted : best;
    return { along: pick.along, offset: Math.sqrt(pick.d2), lat: pick.lat, lon: pick.lon };
  }

  _withinHint(along, hint, window) {
    let d = Math.abs(along - hint);
    if (this.isLoop) d = Math.min(d, this.total - d); // wrap at the start/finish
    return d <= window;
  }

  /** Position on the route at `metres` from the start. */
  atDistance(metres) {
    const d = Math.max(0, Math.min(this.total, metres));
    const c = this.cumulative;
    let lo = 0, hi = c.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (c[mid] <= d) lo = mid; else hi = mid;
    }
    const seg = c[hi] - c[lo];
    const t = seg === 0 ? 0 : (d - c[lo]) / seg;
    const a = this.points[lo], b = this.points[hi];
    return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
  }
}

/**
 * Turns a stream of GPS fixes into a progress reading.
 *
 * A single fix that projects backwards is ignored; progress only gives ground
 * once the retreat persists across fixes or is too large to be noise. That
 * keeps "distance to finish" from flickering under canopy while still tracking
 * a genuine turnaround. Call reset() when a walker restarts the route.
 */
export class ProgressTracker {
  constructor(route, { maxOffRoute = 60 } = {}) {
    this.route = route;
    this.maxOffRoute = maxOffRoute;
    this.reset();
  }

  reset() {
    this.along = null;
    this.offset = null;
    this.onRoute = false;
    this.startedAt = null;
    this._backwards = 0;
    this._movingMs = 0;
    this._lastFixAt = null;
  }

  /** @returns {{along:number, remaining:number, fraction:number, offset:number, onRoute:boolean, speed:number|null, eta:number|null}} */
  update(lat, lon, at = Date.now()) {
    const fix = this.route.project(lat, lon, this.along);
    const onRoute = fix.offset <= this.maxOffRoute;
    const total = this.route.total;
    let candidate = fix.along;

    if (this.route.isLoop) {
      // Start and finish are the same place, so a fix there projects equally well
      // to either end of the line. Resolve the tie by where the walker already is.
      if (this.along == null) {
        // opening the app on the start line must not read as "finished"
        if (candidate > total - 100) candidate = 0;
      } else if (this.along > total * 0.75 && candidate < total * 0.25) {
        candidate = total;              // closing the loop: this is the finish
      } else if (this.along < total * 0.25 && candidate > total * 0.75) {
        candidate = 0;                  // milling about behind the start line
      }
    }

    if (this.along == null) {
      this.along = candidate;
      this.startedAt = at;
    } else if (candidate >= this.along) {
      this.along = candidate;
      this._backwards = 0;
    } else {
      // Accept a backwards move only once it has persisted (a genuine turnaround
      // or a corrected fix), not on a single jittery sample.
      this._backwards++;
      if (this._backwards >= 3 || candidate - this.along < -150) {
        this.along = candidate;
        this._backwards = 0;
      }
    }

    if (this._lastFixAt != null) this._movingMs += Math.min(at - this._lastFixAt, 30000);
    this._lastFixAt = at;

    this.offset = fix.offset;
    this.onRoute = onRoute;

    const elapsed = this._movingMs / 1000;
    const speed = elapsed > 60 && this.along > 50 ? this.along / elapsed : null; // m/s
    const remaining = Math.max(0, this.route.total - this.along);

    return {
      along: this.along,
      remaining,
      fraction: this.route.total ? this.along / this.route.total : 0,
      offset: fix.offset,
      onRoute,
      snapped: [fix.lat, fix.lon],
      speed,
      eta: speed && speed > 0.15 ? remaining / speed : null,
    };
  }
}
