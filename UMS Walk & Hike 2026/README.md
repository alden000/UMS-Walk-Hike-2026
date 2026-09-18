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

Checkpoints are the landmarks listed below.

**Weather** — "now" plus +2 h, +4 h and +6 h, as icons with temperatures in °C,
from NEA. See [Weather sources](#weather-sources).

**Controls** — zoom in / out, centre on my position, **Follow me** (re-centres
every second; also available as a checkbox in the layers drawer), fit the whole
route, and a base-map switcher.

**Built for the phone** — the event device is a phone in one hand, so the layout
is driven from there: the forecast collapses to a single line, panels measure
themselves and keep the control stack clear, tap targets stay finger-sized, the
distance read-outs are large enough for arm's length in sunlight, and the whole
thing is checked at 320 px as well as 390 px. Tablet and desktop get the roomier
version for planning: the forecast opens by default and the panels widen.

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

### Checkpoints — landmarks along the route

**The supplied KML contains no checkpoint placemarks — only the track.** The
twelve checkpoints in `data/checkpoints.json` are therefore the landmarks and
attractions the route actually passes, picked from the OpenStreetMap extract and
ordered by distance. Start and finish are pinned to the KML's own first and last
point, the **Windsor Nature Park carpark**.

| km | Landmark | |
|---:|---|---|
| 0.00 | **Start / Finish** — Windsor Nature Park Carpark | |
| 0.67 | Venus Drive Ruins | old kampong ruins by the Squirrel Trail boardwalk |
| 2.43 | MacRitchie Ranger Station | toilets, drinking water, AED |
| 3.08 | **HSBC TreeTop Walk** | 250 m suspension bridge |
| 3.31 | Bukit Kallang | high point, at the bridge's far end |
| 3.60 | Petaling Boardwalk | down to Petaling Hut |
| 4.68 | **Jelutong Tower** | seven-storey canopy observation tower |
| 5.55 | Syonan Jinja Ruins | wartime shrine — 215 m off the path |
| 7.34 | Jering Hut | shelter with an AED |
| 8.47 | The Leaning Tree of MacRitchie | on the Chemperai Trail |
| 9.39 | Lim Bo Seng Memorial | war memorial and grave |
| 9.99 | MacRitchie Reservoir Park | cafe, toilets, water, AED |
| 11.38 | Petai Trail Boardwalk | last boardwalk before Windsor |
| 13.25 | **Finish** — Windsor Nature Park Carpark | |

A checkpoint more than 40 m off the path says so in its popup, so nobody hunts
for the Syonan Jinja ruins from the trail itself.

These are landmarks, not the organiser's official checkpoints. If the organiser
publishes a different list, replace the file — it is plain JSON and the only
thing you need to edit:

```json
{ "id": "cp1", "name": "Venus Drive Ruins", "note": "Old kampong ruins",
  "along": 668, "offset": 0, "lat": 1.360788, "lon": 103.822113 }
```

`along` is metres from the start and drives the "distance to next checkpoint"
readout and the ticks on the progress bar; `build_data.py` recomputes `along`
and `offset` from `lat`/`lon` for anything you add to its `LANDMARKS` table.

### Weather, air quality and risk

All official NEA feeds via data.gov.sg — open, keyless, CORS-enabled:

| Reading | Source |
|---|---|
| **Now** — condition | `two-hr-forecast`, nowcast for the forecast areas the route crosses (Bishan, Central Water Catchment, Novena). Where they disagree the wettest wins, so the card warns rather than reassures. |
| **Now** — temperature, humidity, wind, rain | `air-temperature`, `relative-humidity`, `wind-speed`, `rainfall` — the station nearest you. |
| **+2 h** — condition | The 2-hour nowcast, which is exactly this window. |
| **+4 h / +6 h** — condition | `twenty-four-hr-forecast`, the period covering that time, central region. |
| **+2/4/6 h** — temperature | **Estimated.** NEA publishes a daily high/low, not an hourly temperature forecast, so the app tracks the current reading along a diurnal curve (minimum ~06:00, maximum ~14:00) bounded by today's range. Shown with a `~`. |
| **PSI** | `psi` — 24-hour PSI for the central region, the figure NEA's own health advisories use. |
| **PM2.5** | `pm25` — 1-hour PM2.5 for the central region. |
| **UV index** | `uv` — hidden at night, when it reads 0. |

**Collapsing.** The panel folds down to a one-line summary — condition, icon,
temperature, PSI and PM2.5 — which keeps refreshing on the same 5-minute cycle
whether it is open or shut. Phones start collapsed (map space is scarce),
tablets and desktops start open, and your choice is remembered. On a phone the
open panel is a bottom sheet, so the control stack steps aside while it is up.

**Risk banner.** Shown in both states, because that is the point of it:

| | Raised when |
|---|---|
| **Red — severe** | Thundery showers now or within 2 h (lightning); heavy rain now; PSI above 100; PM2.5 above 150 |
| **Amber — warn** | Thundery showers later today; showers now or within 2 h; PSI 51–100; PM2.5 56–150; UV 6 or above |
| none | everything below those thresholds |

Red also puts a pulsing border on the whole panel, so a storm warning is
readable at a glance in bright sun. The banner carries the single most serious
warning plus a `+n more` chip; the full list sits in the expanded panel.

**On lightning specifically** — NEA's lightning-strike feed is not public
(`/lightning` returns *Missing Authentication Token*), so the app cannot show
live strikes. It infers lightning risk from the official forecast codes `TL`,
`HT` and `HG` — thundery showers, heavy thundery showers, and heavy thundery
showers with gusty winds. **Treat the banner as a prompt to check the sky and
NEA's own advisories, not as a strike detector.**

**On a PSI forecast** — NEA publishes no PSI or PM2.5 forecast feed, only
current readings. Rather than invent one, the PM2.5 tile shows a trend: the
1-hour reading against its own 24-hour average, so `↑ rising` means the air is
getting worse right now and `↓ easing` that the haze is clearing.

Weather refreshes every 5 minutes and when the app returns to the foreground,
and keeps a 30-minute local copy so the strip still reads something offline. If
one feed fails on its own — a transient 5xx answers without CORS headers — the
tile keeps its last good reading and the caption says so, rather than blanking.

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

## Deploying to GitHub Pages

`.github/workflows/deploy-pages.yml` publishes this folder as the **site root**,
so the app is served from `https://<owner>.github.io/<repo>/` rather than a URL
containing spaces and an ampersand. `tools/` is left out of the published site.

**Pages has to be switched on once by hand**, because the Actions token is not
allowed to create a Pages site (`configure-pages` fails with *"Create Pages site
failed: Resource not accessible by integration"*):

1. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
2. Re-run the *Deploy to GitHub Pages* workflow (Actions tab → Run workflow), or
   just push to the default branch.

Every later push that touches this folder redeploys automatically.

> **Note for private repositories:** GitHub Pages is only available on private
> repos with a paid plan (Pro / Team / Enterprise). On a Free account, Settings →
> Pages will refuse until the repository is made public. Also note that unless
> you are on Enterprise with private Pages, **a published Pages site is public**
> even when the repository is private.

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
