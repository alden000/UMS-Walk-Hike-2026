# UMS Walk & Hike 2026

An offline-capable PWA for the UMS Walk & Hike 2026 route: a full-screen map with
the event route and checkpoints, live progress along the route, the facilities
that matter on the day (AEDs, toilets, drinking water, drink machines, shelter
huts) and a live + short-range weather strip.

Built from the supplied `UMS_Walk_2026.kml`. No build step, no framework, no
tracking — open `index.html` from any static web server.

## The route

| | |
|---|---|
| Distance | **13.25 km**, a closed loop |
| Start / finish | Windsor Nature Park (1.359789, 103.827313) |
| Area | Windsor Nature Park → Sime Forest → MacRitchie Reservoir → Lornie / Thomson |
| Ascent | ~92 m cumulative, 16 m to 68 m elevation |
| Track points | 428 |

## What it does

**Map** — full-screen canvas. Route drawn in orange, the part already walked
redrawn in green behind your position. Kilometre pips every 1 km. Panning and
zooming are fenced to the route plus a 1 km margin, so the map cannot be lost.

**Progress** — from the device GPS, projected onto the route: distance covered,
distance to the finish, percent complete, distance to the next checkpoint, moving
average pace and an ETA. The progress bar carries checkpoint ticks and your
position. Being more than 60 m off the line raises an "off route" warning.

Because the route is a loop that doubles back on itself, a naive nearest-point
match would jump between the outbound and return legs. The tracker keeps a hint
of where you were and prefers candidates near it, and only accepts backwards
movement once it persists — so the remaining distance does not flicker.

**Markers** — each category has its own pin shape and colour, and every popup
gives the position as *km along the route* plus how far off the path it sits.

| | Category | Found near the route |
|---|---|---|
| 🔴 | AEDs | 5 (all within 72 m of the path) |
| 🔵 | Toilets | 10 |
| 🩵 | Drinking water | 4 |
| 🟣 | Drink / snack machines | 4 |
| 🟢 | Shelters & huts | 37 (off by default — they are dense) |

**Weather** — "now" plus +2 h, +4 h and +6 h, as icons with temperatures in °C,
from NEA. See [Weather sources](#weather-sources).

**Controls** — zoom in / out, centre on my position, **Follow me** (re-centres
every second; also available as a checkbox in the layers drawer), fit the whole
route, and a base-map switcher.

**Offline** — a service worker precaches the app shell and all route data, and
caches map tiles as you view them (capped at 1200). Open the app over the route
once on wi-fi and it will work in the reserve, where coverage is patchy. Install
it to the home screen for a full-screen, chrome-free map.

## Base maps

| Layer | Source | Notes |
|---|---|---|
| **Singapore (OneMap)** | OneMap / Singapore Land Authority | The official national basemap. Shows park connectors, nature-reserve paths and reservoir detail. Default. |
| **Trail map** | OneMap Grey + local trail overlay | Muted base with every footpath, track and flight of steps in the corridor drawn on top (1,458 ways), aligned 1:1 with the ground. |
| **Satellite** | Esri World Imagery | Canopy hides most of the trail surface inside the reserve. |
| **Street (OSM)** | OpenStreetMap standard | The same data the markers come from. |

### On an NParks layer

You asked whether NParks' own map could be a layer. It cannot, directly: NParks
does not publish a public tile service or ArcGIS REST endpoint — `nparksmaps.nparks.gov.sg`
is not reachable from outside their network, and their trail maps are published as
PDFs and artwork rather than georeferenced tiles. Anything scraped from those would
not line up 1:1 with the map.

The two layers that get closest, and are both official or verifiable:

- **OneMap** is the Singapore government's authoritative basemap and already
  renders NParks park connectors, nature-reserve trails and park boundaries.
- **Trail map** draws the footpath network itself as vectors, so every trail,
  boardwalk and stairway in the corridor is visible at any zoom, correctly
  positioned, and works offline.

If NParks later exposes a WMTS/WMS endpoint, adding it is a single entry in the
`BASEMAPS` array in `js/app.js`.

## Data sources

### Facilities (AEDs, toilets, water, vending, shelters)

All of these come from **OpenStreetMap**, pulled via the OSM API for the route
corridor and filtered to what is on or near the route (`tools/build_data.py`).

**On the AED data specifically** — you asked for SCDF / myResponder as the source.
That registry is not available as an open feed: myResponder has no public API, and
SCDF's AED registry is distributed through OneMap's `aedlocations` theme, which
requires a registered OneMap account token that this build has no credentials for.
The data.gov.sg catalogue API also exposes no working text search, so the dataset
could not be located programmatically.

What is shipped instead is OpenStreetMap's `emergency=defibrillator` data, which
for this corridor is detailed and plausible — three of the five AEDs carry
cabinet-level descriptions ("Inside Jering Hut shelter", "Ranger station –
entrance to female toilet") and 24/7 opening hours. **Treat it as indicative, not
as an authoritative SCDF registry**, and verify against myResponder before the
event.

To swap in the official data when you have a OneMap token, replace the `aed`
array in `data/pois.json`; every entry needs `name`, `lat`, `lon`, `offset`
(metres off the route), `along` (metres from the start) and optionally `detail`.
Running `tools/build_data.py` recomputes `offset` and `along` for you.

### Checkpoints — provisional

**The supplied KML contains no checkpoint placemarks — only the track.** The eight
checkpoints shipped in `data/checkpoints.json` are therefore placeholders, spaced
every 2 km and snapped to a named NParks hut where one is within 300 m (Dillenia
Hut, Chemperai Hut, Rambai Hut and so on).

Replace them with the organiser's official list before the event. The file is
plain JSON and is the only thing you need to edit:

```json
{ "id": "cp1", "name": "Checkpoint 1", "along": 2000,
  "lat": 1.355298, "lon": 103.813817, "note": "Water point" }
```

`along` is metres from the start and drives the "distance to next checkpoint"
readout and the ticks on the progress bar.

### Weather sources

All official NEA feeds via data.gov.sg — open, keyless, CORS-enabled:

| Card | Source |
|---|---|
| **Now** — condition | `two-hr-forecast`, nowcast for the forecast areas the route crosses (Bishan, Central Water Catchment, Novena). Where they disagree, the wettest wins, so the card warns rather than reassures. |
| **Now** — temperature, humidity, wind, rain | `air-temperature`, `relative-humidity`, `wind-speed`, `rainfall` — live readings from the station nearest you. |
| **+2 h** — condition | The 2-hour nowcast, which is exactly this window. |
| **+4 h / +6 h** — condition | `twenty-four-hr-forecast`, the period covering that time, for the **central** region. |
| **+2/4/6 h** — temperature | **Estimated.** NEA publishes a daily high/low, not an hourly temperature forecast, so the app tracks the current reading along a diurnal curve (minimum ~06:00, maximum ~14:00) bounded by today's forecast range. Shown with a `~` and labelled in the caption; the caption's tooltip spells out the derivation. |

Weather refreshes every 10 minutes and when the app returns to the foreground,
and keeps a 30-minute local copy so the strip still reads something offline.

## Running it

Any static server — the app is plain ES modules, so `file://` will not work.

```bash
cd "UMS Walk & Hike 2026"
python3 -m http.server 8777
# then open http://localhost:8777
```

For the service worker and geolocation, deploy over **HTTPS** (GitHub Pages,
Netlify, Cloudflare Pages — drop the folder in as-is). `localhost` is exempt, so
local testing works over plain HTTP.

## Rebuilding the data

```bash
python3 tools/build_data.py    # route, POIs, trails, checkpoints
python3 tools/make_icons.py    # PWA app icons
```

`build_data.py` re-downloads the OSM extracts into `tools/osm/` if they are
missing (7 tiles, ~45 MB, a couple of minutes). Both scripts are dependency-free
— standard library only.

To use a different route, drop a new KML in `tools/` as `UMS_Walk_2026.kml` and
re-run. Adjust `OSM_TILES` if the new route leaves the current bounding box.

## Layout

```
index.html              app shell
manifest.webmanifest    PWA manifest
sw.js                   service worker: precache + tile cache
css/app.css
js/app.js               map, controls, progress, wiring
js/geo.js               route projection and progress tracking
js/icons.js             marker and weather SVG icon set
js/weather.js           NEA feeds -> the weather model
data/route.json         route geometry, cumulative distance, elevation
data/pois.json          facilities near the route
data/trails.json        footpath network for the trail layer
data/checkpoints.json   provisional checkpoints — edit this
vendor/leaflet.*        Leaflet 1.9.4, vendored for offline use
tools/                  data build scripts + source KML
```

## Before the event — checklist

- [ ] Replace `data/checkpoints.json` with the organiser's official checkpoints.
- [ ] Verify the 5 AED locations against myResponder, or swap in OneMap's
      `aedlocations` theme if you have a token.
- [ ] Deploy over HTTPS and open it once along the route to warm the tile cache.
- [ ] Spot-check toilets and water points — OSM survey dates on some entries go
      back to 2020.

## Attribution

- Route: supplied `UMS_Walk_2026.kml`
- Facility and trail data: © OpenStreetMap contributors, [ODbL](https://opendatacommons.org/licenses/odbl/1-0/)
- Base maps: OneMap © Singapore Land Authority; Esri World Imagery
- Weather: National Environment Agency via data.gov.sg
- Map library: [Leaflet](https://leafletjs.com) 1.9.4 (BSD-2-Clause)
