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

**Map** — full-screen canvas.

The route is drawn in **two colours: green is the ground you have already
covered, orange is what is left.** The split sits at your current position, so
the line itself is the progress bar. Before the first GPS fix the whole route is
orange. A legend under *Line colours* in the layers drawer spells this out, and
the brown hairlines on the Trail map layer are the other footpaths in the area.

Kilometre pips every 1 km. Panning is fenced to the route plus a 2 km margin so
the map cannot be lost, and zoom stops one level below the zoom that fits that
corridor — far enough out to take in the whole route and its surroundings, not
so far that the route becomes a squiggle.

The route is wide and shallow (3.4 km across, 2.6 km deep), so on a tall phone
fitting its width can still make the viewport taller than that corridor. Left alone,
Leaflet then clamps the centre and the map cannot be dragged vertically at all.
The fence is therefore grown to just over the viewport whenever that happens:
nothing new becomes visible — a fence smaller than the screen is not a fence —
the map simply stops being frozen, and marker popups can pan clear of the
panels. Popups that would still sit under the header fold the header away while
they are open.

**Progress** — from the device GPS, projected onto the route: distance covered,
distance to the finish, percent complete, distance to the next landmark, moving
average pace and an ETA. Being more than **500 m** from the line raises an "off
route" warning — deliberately generous, because under canopy a phone fix wanders
and the reserve's trails run close enough together that a walker on the right
path can project a couple of hundred metres off it.

Past that distance the nearest point on a route that doubles back could be
anywhere, so progress is **shown as back at the start** and the whole line reads
as "still to walk" rather than the walked/remaining split jumping about. The last
on-route position is kept internally, so stepping back onto the path resumes from
where you actually were rather than from zero.

The progress bar carries checkpoint ticks and your position, and **stays on
screen when the panel is minimised** — minimising folds away only the four stat
tiles, and the distance remaining and percentage move up into the status line.
Minimised, the whole header is about 80 px tall instead of 165 px.

**Both bars start minimised**, which leaves roughly three quarters of a phone
screen for the map. Expand either one and that choice is remembered.

Because the route is a loop that doubles back on itself, a naive nearest-point
match would jump between the outbound and return legs. The tracker keeps a hint
of where you were and prefers candidates near it, and only accepts backwards
movement once it persists — so the remaining distance does not flicker.

**Markers** — each category has its own pin shape and colour, and every popup
gives the position as *km along the route* plus how far off the path it sits.

Facilities bunch up — the ranger station has a toilet, a water point and an AED
within ten metres, and at the reservoir park a car park, two toilets, water and
an AED sit on the same spot — so the pins used to bury one another. They now
share a single cluster group, and **a cluster shows which kinds of facility it
holds** as a grid of category glyphs with per-category counts, rather than an
anonymous number. Tapping one lists everything inside with its details; tapping
a row zooms to that marker and opens it. Past zoom 18 clustering switches off
and every pin stands on its own. Because all categories share one group,
overlaps *between* categories collapse too, and each category can still be
toggled independently. All categories, shelters included, are on by default.

Checkpoint discs **hang just below** their position while facility pins are
teardrops rising *above* theirs, so a checkpoint and a facility sharing a spot —
as they do at the ranger station and the reservoir park — no longer sit on top
of one another.

| | Category | Found near the route |
|---|---|---|
| 🔴 | AEDs | 5 (all within 72 m of the path) |
| 🔵 | Toilets | 10 |
| 🩵 | Drinking water | 4 |
| 🟣 | Drink / snack machines | 4 |
| 🟢 | Shelters & huts | 37 |
| 🟠 | Car park | Windsor Nature Park, with NParks' lot counts and hours |

Checkpoints are the landmarks listed below.

**Weather** — "now" plus +2 h, +4 h and +6 h, as icons with temperatures in °C,
from NEA. See [Weather sources](#weather-sources).

**Controls** — zoom in / out, centre on my position, **Follow me** (re-centres
every second; also available as a checkbox in the layers drawer), fit the whole
route, and a base-map switcher.

**Which way you are facing** — the blue position dot carries a triangle that
swings round it to show the way the walker is pointing, so the map can be read
without working out which junction exit is which. It takes the device compass
where there is one, which means it turns on the spot rather than only while
walking, and falls back to GPS course over ground (direction of travel, so it
only reads while moving and is ignored below 0.5 m/s). Readings are smoothed and
always rotate the short way round, so crossing north does not spin the arrow.
**No heading, no arrow** — it stays hidden rather than pointing at a guess.

iOS asks permission for the compass and will only raise that prompt from a tap,
so the app waits for the first touch anywhere before asking; declining just
leaves the arrow on GPS course. A compass reading is relative to the top of the
device, so it is corrected by the screen rotation angle: that correction is zero
in portrait, which is how the phone will be held on the walk. The landscape case
follows the usual convention but could not be checked here — no compass exists
in a headless browser — so it is worth a glance on the day if anyone walks with
the phone sideways.

**Emergency card** — the red **SOS** button. One tap for the moment nobody
wants: call buttons (995 for SCDF, the NParks helpline, and the event marshal
once a number is put in `CALLS` at the top of `js/app.js` — the button is hidden
while it is blank); where you are, as coordinates with the fix's accuracy and
age, the km mark on the route, and the distance to the nearest landmark, with
**Copy** and **Share** so it can go straight into a message with a Google Maps
link; and the nearest AED, **drinking water**, toilet and shelter, each a tap
away on the map. The AED data was always on the map; nobody should be hunting
through markers with an incident in front of them.

**Distances follow the route, not the map.** Straight-line distance is close to
useless here: the loop runs round a reservoir and through closed forest. From
km 6.0, the nearest AED is 713 m across the water but **1.3 km of walking**, and
the toilet that looks nearest at 1.4 km is **3.6 km back** along the trail. So
every distance on the card is measured along the route, both ways round the
loop with the shorter winning, plus the few metres from the path to the thing
itself — and each row says **ahead** or **back**, because a facility behind you
is a different decision from one in front. Off the route there is no route
distance to give, so the card falls back to straight line and says so rather
than quoting a number that flatters the walk.

**Surviving a reload** — sooner or later in a four-hour walk the phone kills the
tab. Distance along, start time and moving time are saved to the device every
five seconds while on route and restored on the next open, so the HUD shows the
saved numbers before the first fix rather than zeros, and the ETA carries on.
It matters most on this loop: the finish is the start, so a fresh open near the
end would read as the start line — the restored position settles that. A saved
walk older than eight hours is treated as a previous day's and discarded, and
**Reset progress** in the layers drawer starts over deliberately.

**Screen stays on while following** — Follow mode takes a screen wake lock. A
phone that sleeps after thirty seconds also stops delivering GPS fixes, which
is why "it stopped tracking in my pocket" was the likeliest failure on the day.
The lock is released when Follow is switched off, released by the browser
whenever the page is hidden, and taken again when the page comes back.

**Battery saver GPS** — a continuous high-accuracy watch holds the GPS receiver
on for the whole walk, the single biggest drain on the phone. The toggle in the
layers drawer swaps it for one fix every 30 s, and the receiver sleeps in
between; the status line says "GPS every 30 s" while it is in force. Follow
mode always gets the continuous watch, since re-centring once a second on a
position that changes every thirty makes no sense, and the setting is
remembered. High accuracy stays on in both modes: a network fix is worthless
under the canopy. GPS stops altogether while the page is hidden.

**Built for the phone** — the event device is a phone in one hand, so the layout
is driven from there: the forecast collapses to a single line, panels measure
themselves and keep the control stack clear, tap targets stay finger-sized, the
distance read-outs are large enough for arm's length in sunlight, and the whole
thing is checked at 320 px as well as 390 px. Tablet and desktop get the roomier
version for planning: the forecast opens by default and the panels widen.

**Offline** — a service worker precaches the app shell and all route data, and
caches map tiles as you view them (capped at 1200). Install it to the home
screen for a full-screen, chrome-free map.

**Save map for offline** (layers drawer) — caching tiles as they are viewed
quietly means offline only covers ground you have already scrolled over, which
in the reserve is the difference between a map and a blank screen. This button
downloads every tile the route needs in one go: **209 tiles, about 1.7 MB, 14
seconds** on a decent connection. It covers the route and 400 m either side at
zoom 14–17 — the pan fence is 2 km, but 2 km of forest at z17 would be thousands
of tiles for ground nobody walks on, and z17 is about 1.2 m per pixel, as close
as anyone needs on foot. Closer in than that still needs signal. It saves the
base map you are currently on, so switch and save again for a second one; a save
can be stopped part-way and the tiles already fetched are kept and labelled
"(part)".

Saved tiles live in their own cache, apart from the ones picked up in passing,
for two reasons: the browsing cache is trimmed oldest-first, so a saved map
would be the first thing evicted by an afternoon of panning about; and its name
carries no version, so shipping an app update does not throw away a map someone
downloaded the night before.

The tiles are fetched **as CORS requests, and this is the whole feature**. Done
the obvious way — `no-cors`, as an `<img>` does — every response is opaque, and
an opaque response is padded in Cache Storage accounting so its true size cannot
be probed cross-origin. Chrome's padding is about 7 MB per response. Measured:
131 opaque tiles took usage from 110 MB to **1014 MB** and the save died on a
quota error two-thirds of the way through. All three tile hosts send
`Access-Control-Allow-Origin: *`, so the same 209 tiles fetched as CORS cost
**1.7 MB**, and still render for the plain `<img>` requests Leaflet makes,
because a cache entry is keyed on URL and not on the mode it was fetched with.
The tile layers now set `crossOrigin` for the same reason, so the browsing cache
stops charging megabytes of quota per 20 KB tile as well.

### Checkpoint photos

**Every checkpoint has a photo**, and so does the car park marker. All of them
are the organiser's own photographs of the route, supplied for the event:

| # | Checkpoint | Shows |
|---|---|---|
| — | Start / Finish | the car park, looking in from the entrance |
| 1 | MacRitchie Ranger Station | the ranger station shelter, with a macaque on the rock in front |
| 2 | HSBC TreeTop Walk | looking along the suspension bridge through the canopy |
| 3 | Bukit Kallang | canopy view over the reserve towards the reservoir |
| 4 | Petaling Boardwalk | the boardwalk through the forest |
| 5 | Jelutong Tower | the observation tower above the canopy |
| 6 | Syonan Jinja Ruins | surviving bridge posts standing in the reservoir |
| 7 | Jering Hut | the signed shelter on the Jering Trail |
| 8 | The Leaning Tree of MacRitchie | the leaning tree over the waterside boardwalk |
| 9 | Lim Bo Seng Memorial | the memorial and grave above the reservoir |
| 10 | MacRitchie Reservoir Park | the park pavilion and boardwalk over the water |
| 11 | Petai Trail Boardwalk | the boardwalk deck at the water's edge |

About 700 KB in total at 480 px wide, precached so they work offline. **A photo
with an empty `credit` shows no caption at all**, and every entry now has one, so
no image carries a caption band. The captioning is kept because it is what makes
a sourced image safe to drop in later.

The organiser's photographs settled a question sourced ones could not.
Searching the free image pools for the Lim Bo Seng Memorial kept returning the
Esplanade Park monument on the waterfront — the wrong side of the island from the
grave above the reservoir — so checkpoint 9 had been left blank rather than given
a misleading picture. The supplied photo is the real one. Sourced images filled
checkpoints 1 and 2 for a while and are now replaced as well, so nothing on the
map is a stand-in. Google Maps photos were
never an option: they are copyrighted by Google or by the people who uploaded
them, and the Maps terms forbid copying them out.

To replace or add one, drop the image in `photos/` and add an entry to
`data/photos.json` keyed by the checkpoint's `id` — **the ids match the numbers
drawn on the map**, so checkpoint 8 is `cp8`:

```json
"cp8": { "file": "photos/cp8.jpg", "credit": "", "licence": "" }
```

Add the file to the `SHELL` list in `sw.js` to have it precached, and resize it
to about 480 px wide first (`tools/` has no resizer; any image editor will do).
If the new image needs attribution, fill in `credit` and `licence` and the caption
comes back on its own.

The image is given an explicit height in CSS rather than `max-height`: Leaflet
measures a popup to pan it into view the instant it opens, before the image has
loaded, and an intrinsic height of zero at that moment puts the popup off the top
of the screen.

## Base maps

| Layer | Source | Notes |
|---|---|---|
| **OneMap (SLA)** | OneMap / Singapore Land Authority | The official national basemap. Shows park connectors, nature-reserve paths and reservoir detail. Default. |
| **Trail map** | OneMap Grey + local trail overlay | Muted base with every footpath, track and flight of steps in the corridor drawn on top (1,458 ways), aligned 1:1 with the ground. |
| **Satellite** | Esri World Imagery | Canopy hides most of the trail surface inside the reserve. |
| **Street (OSM)** | OpenStreetMap standard | The same data the markers come from. |

Each row in the picker shows a **real tile from that base map**, taken at the
middle of the route, so it previews what the map will actually look like. The
thumbnail is built from the same URL template the layer itself uses, so it
cannot drift from the map it stands for, and because it is an ordinary tile the
service worker caches it like any other. If it has not loaded, the flat `tint`
colour shows behind it.

The picker is a **pick-one** control, so it carries a radio dot on the right.
It previously showed only a small flat colour swatch on the left: three of the
four base maps are pale, so at that size they read as four *unticked boxes*,
especially sitting directly above the marker tickboxes, and the row highlight
was the only thing saying which layer was live. The OneMap row is labelled
"OneMap (SLA)" rather than "Singapore (OneMap)" because the longer name no
longer fits on one line — and every base map here is Singapore.

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
eleven checkpoints in `data/checkpoints.json` are therefore the landmarks and
attractions the route actually passes, picked from the OpenStreetMap extract and
ordered by distance. Start and finish are pinned to the KML's own first and last
point, the **Windsor Nature Park carpark**.

| km | Landmark | |
|---:|---|---|
| 0.00 | **Start / Finish** — Windsor Nature Park Carpark | |
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
{ "id": "cp1", "name": "MacRitchie Ranger Station", "note": "Toilets, drinking water and an AED",
  "along": 2433, "offset": 5, "lat": 1.357037, "lon": 103.812658 }
```

Checkpoint ids match the numbers drawn on the map, so `cp1` is the disc marked
**1**. An earlier "Venus Drive Ruins" entry was dropped: OpenStreetMap tags three
points along Venus Drive as an unnamed "Ruins" attraction, but nothing
corroborates what they are, so it was not worth sending walkers to look for it.

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
whether it is open or shut. It starts minimised, as the header does, and your
choice is remembered per device. On a phone the open panel is a bottom sheet, so
the control stack steps aside while it is up.

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

**Refresh cadence.** Every **5 minutes**, plus whenever the app returns to the
foreground, whenever the browser reports the connection is back, and on demand
from the refresh button. A 30-minute local copy is kept so the strip still reads
something offline.

**Reliability.** Nine feeds used to be fetched all at once, and roughly one
request in six failed — not an HTTP error but a connection-level drop from too
many simultaneous requests to the same host, which left the card blank until the
next 5-minute tick. They now run three at a time, most important first, each
retried up to three times with a short backoff; a whole failed load retries after
5 s, then 10 s, up to a minute, instead of waiting out the cycle. A feed that
still fails keeps its last good reading — temperature, humidity, wind, PSI, PM2.5
and UV all carry over — and the caption says so. Measured before and after over
repeated cold loads: 5/6, then 8/8.

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

## Hosting it on a LAN

The event copy is the HTTPS one at
**https://alden000.github.io/UMS-Walk-Hike-2026/** — use that for the walk
itself. A LAN copy is a fine backup for looking at the map, with one important
limit.

**GPS and offline caching need a secure context.** Browsers grant geolocation and
register service workers only on HTTPS, with `localhost` as the sole exemption —
a LAN address such as `http://192.168.1.20:8080` does **not** qualify. Served
that way the app still shows the map, the route, every marker and the live NEA
weather, but:

| | over `http://<lan-ip>` |
|---|---|
| Map, route, markers, checkpoint photos | ✅ work |
| Weather and air quality | ✅ work (needs internet) |
| Live progress tracking | ❌ GPS refused: *"Only secure origins are allowed"* |
| Offline caching | ❌ the service worker API is not even exposed |

The app detects this and says so directly — *"Opened over plain HTTP — GPS and
offline need HTTPS"* — rather than reporting it as a permission problem, which is
what the browser's own error looks like and would send people hunting through
phone settings for nothing.

To serve the LAN copy:

```bash
cd "UMS Walk & Hike 2026"
python3 -m http.server 8080 --bind 0.0.0.0
# then http://<your-lan-ip>:8080 from any device on the network
```

If you later want the LAN copy to do tracking and offline too, it needs a
certificate — `mkcert` for a local CA, Tailscale for automatic real certs, or a
DNS-01 Let's Encrypt cert for a hostname pointed at the LAN IP. Ask and I'll add
the setup.

## Rebuilding the data

```bash
python3 tools/build_data.py    # route, POIs, trails, checkpoints
python3 tools/make_icon.py     # icons/icon.svg + icons/icon-maskable.svg
```

`build_data.py` re-downloads the OSM extracts into `tools/osm/` if they are
missing (7 tiles, ~45 MB, a couple of minutes). Both scripts are standard
library only.

`make_icon.py` writes the two SVGs; the PNGs beside them were rasterised from
those with headless Chromium at 512 and 192 px, and any SVG rasteriser will do.
The trail is not a hand-drawn outline: a centreline is sampled and a width that
tapers with distance is offset along its normal. A tapered ribbon folds over
itself wherever it is wider than the bend it is going round, so the script
compares the half-width against the radius of curvature at every sample and
refuses to draw a trail that pinches — the current one clears by 1.36x.

### The icon

A trail winding up through the reserve to a ridge, with the app's green position
marker sitting on it. The previous icon was the route's own loop drawn in the
walked/remaining colours, which at launcher size was just an abstract ring with
no clue what it stood for. This one has to survive 48 px and an arbitrary OS
mask, so it is built from a handful of large shapes, and the maskable variant is
the same scene with a wider camera: the sun, the trail, the marker and both
trees all sit inside the safe circle, while the sky and hills still bleed to
every edge. `index.html` also links the SVG as a favicon, which stays crisp in
a browser tab where a downscaled PNG would not.

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
icons/                  app icons (SVG sources + rasterised PNGs)
tools/                  data build scripts + source KML
```

## Before the event — checklist

- [ ] Replace `data/checkpoints.json` with the organiser's official checkpoints.
- [ ] Verify the 5 AED locations against myResponder, or swap in OneMap's
      `aedlocations` theme if you have a token.
- [ ] Deploy over HTTPS and open it once along the route to warm the tile cache.
- [ ] Spot-check toilets and water points — OSM survey dates on some entries go
      back to 2020.

## The Windsor Nature Park car park

The car park is on the map as an amber **P** marker at the start, carrying
NParks' own published details:

| | |
|---|---|
| Address | 30 Venus Drive, Singapore 573858 |
| Position | the route's own start/finish point |
| Lots | 104 car, 10 motorcycle, 2 accessible |
| Cost | Free |
| Hours | 7am–7pm daily; no entry or exit outside those hours |
| Overnight | Not allowed |

NParks' own wording: *"As the carpark has limited lots, do seek proper
alternative parking arrangements when the carpark is full."* With 104 lots for a
whole event field, arriving early matters.

### There is no live lot-availability feed for it

Checked, and the popup says so plainly rather than leaving people wondering:

| Source | Result |
|---|---|
| `api.data.gov.sg/v1/transport/carpark-availability` | Works (2,016 car parks, updated each minute) but **HDB car parks only**. Every entry was cross-checked against the HDB Car Park Information dataset, converting its SVY21 coordinates to WGS84: the nearest is 449 m away, at Bright Hill Drive. Nothing at the nature park. |
| `api-open.data.gov.sg/v2/real-time/api/carpark-availability` | 403, *Missing Authentication Token* — not an open v2 endpoint. |
| LTA DataMall `CarParkAvailabilityv2` | Needs a registered AccountKey, which this build does not have. It covers HDB, URA and LTA car parks; NParks nature-park car parks are generally not among them, but this could not be verified either way. |

Data for the marker is curated by hand in the `MANUAL_POIS` table in
`tools/build_data.py`, because OpenStreetMap carries no capacity or fee tags for
this car park. Its position is taken from the route's first KML point rather than
from a geocoded street address — geocoding "30 Venus Drive" put the pin 95 m away
from where the walk actually starts — so it follows the route if the KML is ever
redrawn. If a live feed ever appears, that is where to wire it in.

## Attribution## Attribution

- Route: supplied `UMS_Walk_2026.kml`
- Facility and trail data: © OpenStreetMap contributors, [ODbL](https://opendatacommons.org/licenses/odbl/1-0/)
- Base maps: OneMap © Singapore Land Authority; Esri World Imagery
- Weather: National Environment Agency via data.gov.sg
- Map library: [Leaflet](https://leafletjs.com) 1.9.4 (BSD-2-Clause)
