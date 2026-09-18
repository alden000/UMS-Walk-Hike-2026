#!/usr/bin/env python3
"""Build the static data files the PWA ships with.

Inputs
  tools/UMS_Walk_2026.kml          the event track (GPS trace of the route)
  tools/osm/*.xml                  OpenStreetMap map-call extracts covering the
                                   route + ~1.5 km buffer.  Downloaded on demand
                                   from the OSM API when missing.

Outputs (written to data/)
  route.json        route geometry, cumulative distance, elevation profile
  pois.json         AEDs / toilets / water / vending / shelters near the route
  trails.json       the surrounding footpath / trail network (map overlay)
  checkpoints.json  provisional event checkpoints (see README)

Run:  python3 tools/build_data.py
"""
import glob
import json
import math
import os
import re
import urllib.request
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OSM_DIR = os.path.join(HERE, "osm")
DATA_DIR = os.path.join(ROOT, "data")
KML = os.path.join(HERE, "UMS_Walk_2026.kml")

# Tiles of the OSM "map call" bbox (minlon,minlat,maxlon,maxlat).  The API caps a
# single call at 50k nodes, so the route area is fetched as several tiles.
OSM_TILES = [
    "103.7949,1.3271,103.8212,1.3498",
    "103.8212,1.3271,103.8475,1.3498",
    "103.7949,1.3498,103.8212,1.3725",
    "103.8212,1.3498,103.8344,1.3612",
    "103.8344,1.3498,103.8475,1.3612",
    "103.8212,1.3612,103.8344,1.3725",
    "103.8344,1.3612,103.8475,1.3725",
]

# How far off the route a POI may be and still be "near or along the route".
# Shelters are dense in the nature reserve, so they get a tighter radius.
MAX_OFFSET_M = {
    "aed": 1000, "toilet": 800, "water": 800, "vending": 800, "shelter": 400, "parking": 1000,
}


# Facilities OpenStreetMap does not carry, entered by hand from the operator's
# own published information. `detail` is the one-line summary under the name;
# `note` is the longer advisory shown beneath it.
MANUAL_POIS = {
    "parking": [
        {
            "id": "nparks-windsor-carpark",
            "name": "Windsor Nature Park Carpark",
            "detail": "Free \u00b7 104 car, 10 bike, 2 accessible lots \u00b7 7am\u20137pm",
            "note": (
                "30 Venus Drive. Limited lots \u2014 arrive early; no overnight "
                "parking. No live availability feed exists for this carpark."
            ),
            "lat": 1.360478,
            "lon": 103.826813,
            "source": "NParks park listing for Windsor Nature Park",
        }
    ],
}

R_EARTH = 6371008.8


def haversine(a, b):
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp = p2 - p1
    dl = math.radians(b[1] - a[1])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R_EARTH * math.asin(math.sqrt(h))


def read_route():
    kml = open(KML, encoding="utf-8").read()
    raw = re.search(r"<coordinates>(.*?)</coordinates>", kml, re.S).group(1)
    pts = []
    for chunk in raw.split():
        lon, lat, ele = chunk.split(",")
        pts.append([round(float(lat), 6), round(float(lon), 6), round(float(ele), 1)])
    return pts


def fetch_osm():
    os.makedirs(OSM_DIR, exist_ok=True)
    for i, bbox in enumerate(OSM_TILES, 1):
        path = os.path.join(OSM_DIR, "tile%d.xml" % i)
        if os.path.exists(path) and os.path.getsize(path) > 10000:
            continue
        url = "https://api.openstreetmap.org/api/0.6/map?bbox=" + bbox
        print("downloading", url)
        with urllib.request.urlopen(url, timeout=180) as r, open(path, "wb") as f:
            f.write(r.read())


def classify(t):
    """Map OSM tags to one of our POI categories, or None to ignore."""
    amenity = t.get("amenity", "")
    if t.get("emergency") == "defibrillator" or amenity == "defibrillator":
        return "aed"
    if amenity == "toilets":
        return "toilet"
    if amenity in ("drinking_water", "water_point"):
        return "water"
    if t.get("man_made") == "water_tap" and t.get("drinking_water") != "no":
        return "water"
    if amenity == "vending_machine":
        vending = t.get("vending", "")
        # drink machines are the ask; food machines usually sell drinks too
        if vending == "" or any(k in vending for k in ("drink", "water", "beverage", "food")):
            return "vending"
        return None
    if amenity == "shelter":
        # bus-stop shelters are not "shelter huts"
        if t.get("shelter_type") == "public_transport":
            return None
        return "shelter"
    if t.get("tourism") == "wilderness_hut" or t.get("building") in ("hut", "pavilion"):
        return "shelter"
    if t.get("leisure") == "picnic_shelter":
        return "shelter"
    return None


def parse_osm():
    """Return [(osm_id, lat, lon, tags)] for every tagged node/way in the extracts."""
    nodes, elements = {}, []
    for path in sorted(glob.glob(os.path.join(OSM_DIR, "*.xml"))):
        root = ET.parse(path).getroot()
        for el in root:
            if el.tag == "node":
                nodes[el.get("id")] = (float(el.get("lat")), float(el.get("lon")))
        for el in root:
            tags = {tag.get("k"): tag.get("v") for tag in el.findall("tag")}
            if not tags:
                continue
            if el.tag == "node":
                lat, lon = float(el.get("lat")), float(el.get("lon"))
            elif el.tag == "way":
                pts = [nodes[nd.get("ref")] for nd in el.findall("nd") if nd.get("ref") in nodes]
                if not pts:
                    continue
                lat = sum(p[0] for p in pts) / len(pts)
                lon = sum(p[1] for p in pts) / len(pts)
            else:
                continue
            elements.append((el.tag[0] + el.get("id"), lat, lon, tags))
    return elements


class RouteIndex:
    """Projects lat/lon onto the route: offset distance and distance-along."""

    def __init__(self, route):
        lat0 = sum(p[0] for p in route) / len(route)
        self.mlat = 110574.0
        self.mlon = 111320.0 * math.cos(math.radians(lat0))
        self.xy = [(p[1] * self.mlon, p[0] * self.mlat) for p in route]
        self.cum = [0.0]
        for i in range(1, len(route)):
            self.cum.append(self.cum[-1] + haversine(route[i - 1], route[i]))

    def project(self, lat, lon):
        px, py = lon * self.mlon, lat * self.mlat
        best_d2, best_along = float("inf"), 0.0
        for i in range(len(self.xy) - 1):
            ax, ay = self.xy[i]
            bx, by = self.xy[i + 1]
            dx, dy = bx - ax, by - ay
            seg2 = dx * dx + dy * dy
            t = 0.0 if seg2 == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / seg2))
            cx, cy = ax + t * dx, ay + t * dy
            d2 = (px - cx) ** 2 + (py - cy) ** 2
            if d2 < best_d2:
                best_d2 = d2
                best_along = self.cum[i] + t * (self.cum[i + 1] - self.cum[i])
        return math.sqrt(best_d2), best_along


TRAIL_TYPES = ("path", "footway", "track", "steps", "cycleway", "pedestrian", "bridleway")


def build_trails(route_index, corridor_m=1000):
    """Footpath/trail centrelines within the corridor, for the trail-map overlay.

    Gives an NParks-style walking map that lines up 1:1 with the basemap, which
    NParks' own tiles cannot (they are not served publicly).
    """
    nodes, out = {}, []
    for path in sorted(glob.glob(os.path.join(OSM_DIR, "*.xml"))):
        root = ET.parse(path).getroot()
        for el in root:
            if el.tag == "node":
                nodes[el.get("id")] = (float(el.get("lat")), float(el.get("lon")))
        for el in root:
            if el.tag != "way":
                continue
            tags = {t.get("k"): t.get("v") for t in el.findall("tag")}
            if tags.get("highway") not in TRAIL_TYPES:
                continue
            pts = [nodes[nd.get("ref")] for nd in el.findall("nd") if nd.get("ref") in nodes]
            if len(pts) < 2:
                continue
            # keep the way if any vertex falls inside the corridor
            if min(route_index.project(la, lo)[0] for la, lo in pts) > corridor_m:
                continue
            out.append(
                {
                    "name": tags.get("name", ""),
                    "kind": "steps" if tags.get("highway") == "steps" else "path",
                    "pts": [[round(la, 5), round(lo, 5)] for la, lo in pts],
                }
            )
    # de-duplicate ways that appear in two overlapping extracts
    seen, uniq = set(), []
    for w in out:
        key = (w["pts"][0][0], w["pts"][0][1], w["pts"][-1][0], w["pts"][-1][1], len(w["pts"]))
        if key in seen:
            continue
        seen.add(key)
        uniq.append(w)
    return uniq


def poi_name(cat, tags):
    if tags.get("name"):
        return tags["name"]
    if cat == "aed":
        return tags.get("defibrillator:location") or tags.get("location") or "AED"
    return {
        "toilet": "Toilet",
        "water": "Drinking water",
        "vending": "Vending machine",
        "shelter": "Shelter",
    }[cat]


def poi_detail(cat, tags):
    bits = []
    if cat == "aed":
        loc = tags.get("defibrillator:location") or tags.get("location")
        if loc and loc != poi_name(cat, tags):
            bits.append(loc)
        if tags.get("indoor") == "no":
            bits.append("Outdoor unit")
        if tags.get("opening_hours"):
            bits.append(tags["opening_hours"])
    if cat == "toilet":
        if tags.get("fee") == "no":
            bits.append("Free")
        if tags.get("wheelchair") == "yes":
            bits.append("Wheelchair accessible")
        if tags.get("toilets:handwashing") == "yes":
            bits.append("Handwashing")
        if tags.get("changing_table") == "yes":
            bits.append("Changing table")
    if cat == "water":
        if tags.get("bottle") == "yes":
            bits.append("Bottle filling")
        if tags.get("fountain") == "bubbler":
            bits.append("Bubbler")
        if tags.get("man_made") == "water_tap":
            bits.append("Tap")
    if cat == "vending":
        v = tags.get("vending", "")
        if "drink" in v:
            bits.append("Drinks")
        if "food" in v:
            bits.append("Food")
    if cat == "shelter":
        st = tags.get("shelter_type", "").replace("_", " ")
        if st:
            bits.append(st[0].upper() + st[1:])
    if tags.get("operator"):
        bits.append(tags["operator"])
    return " · ".join(bits)


def build_pois(route_index):
    elements = parse_osm()
    seen, out = set(), {}
    for osm_id, lat, lon, tags in elements:
        cat = classify(tags)
        if not cat:
            continue
        offset, along = route_index.project(lat, lon)
        if offset > MAX_OFFSET_M[cat]:
            continue
        key = (cat, round(lat, 5), round(lon, 5))
        if key in seen:
            continue
        seen.add(key)
        out.setdefault(cat, []).append(
            {
                "id": osm_id,
                "name": poi_name(cat, tags),
                "detail": poi_detail(cat, tags),
                "lat": round(lat, 6),
                "lon": round(lon, 6),
                "offset": round(offset),
                "along": round(along),
            }
        )
    for cat, items in MANUAL_POIS.items():
        for item in items:
            entry = dict(item)
            offset, along = route_index.project(entry["lat"], entry["lon"])
            entry["offset"] = round(offset)
            entry["along"] = round(along)
            out.setdefault(cat, []).append(entry)

    for cat in out:
        out[cat].sort(key=lambda p: p["along"])
    return out


# Event checkpoints: the landmarks and attractions the route actually passes,
# picked from the OpenStreetMap extract (see tools/landmarks note in README).
# Coordinates are the landmark itself; `along` and `offset` are derived from the
# route, so a checkpoint slightly off the path still reports honestly.
#
# Start and finish are pinned to the KML's own first/last point, which is the
# Windsor Nature Park carpark.
LANDMARKS = [
    ("cp1", "Venus Drive Ruins", "Old kampong ruins beside the Squirrel Trail boardwalk",
     1.360788, 103.822113),
    ("cp2", "MacRitchie Ranger Station", "Toilets, drinking water and an AED",
     1.357037, 103.812658),
    ("cp3", "HSBC TreeTop Walk", "250 m suspension bridge between Bukit Peirce and Bukit Kallang",
     1.361047, 103.811396),
    ("cp4", "Bukit Kallang", "High point of the route at the TreeTop Walk's far end",
     1.361352, 103.809444),
    ("cp5", "Petaling Boardwalk", "Boardwalk down through Petaling Trail to Petaling Hut",
     1.359114, 103.808382),
    ("cp6", "Jelutong Tower", "Seven-storey observation tower over the forest canopy",
     1.351378, 103.806397),
    ("cp7", "Syonan Jinja Ruins", "Wartime Shinto shrine remains - a short detour off the path",
     1.348265, 103.813815),
    ("cp8", "Jering Hut", "Shelter on the Jering Trail, with an AED",
     1.340957, 103.820021),
    ("cp9", "The Leaning Tree of MacRitchie", "Landmark tree on the Chemperai Trail",
     1.343695, 103.826444),
    ("cp10", "Lim Bo Seng Memorial", "War memorial and grave above the reservoir shore",
     1.341900, 103.830987),
    ("cp11", "MacRitchie Reservoir Park", "Main park hub - cafe, toilets, water point and AED",
     1.342473, 103.834908),
    ("cp12", "Petai Trail Boardwalk", "Last boardwalk stretch before the return to Windsor",
     1.350430, 103.831233),
]


def build_checkpoints(route, index, pois):
    """Landmark checkpoints, ordered by distance along the route."""
    del pois  # kept for signature stability; landmarks are curated, not derived
    total = index.cum[-1]

    cps = [
        {
            "id": "start",
            "name": "Start / Finish",
            "note": "Windsor Nature Park Carpark",
            "along": 0,
            "offset": 0,
            "lat": route[0][0],
            "lon": route[0][1],
        }
    ]

    for cp_id, name, note, lat, lon in LANDMARKS:
        offset, along = index.project(lat, lon)
        cps.append(
            {
                "id": cp_id,
                "name": name,
                "note": note,
                "along": round(along),
                "offset": round(offset),
                "lat": lat,
                "lon": lon,
            }
        )

    cps.sort(key=lambda c: c["along"])
    cps.append(
        {
            "id": "finish",
            "name": "Finish",
            "note": "Windsor Nature Park Carpark",
            "along": round(total),
            "offset": 0,
            "lat": route[-1][0],
            "lon": route[-1][1],
        }
    )
    return cps


def main():
    os.makedirs(DATA_DIR, exist_ok=True)
    route = read_route()
    index = RouteIndex(route)
    total = index.cum[-1]

    lats = [p[0] for p in route]
    lons = [p[1] for p in route]
    eles = [p[2] for p in route]
    gain = sum(max(0.0, route[i][2] - route[i - 1][2]) for i in range(1, len(route)))

    route_doc = {
        "name": "UMS Walk & Hike 2026",
        "source": "UMS_Walk_2026.kml",
        "totalDistance": round(total, 1),
        "isLoop": haversine(route[0], route[-1]) < 25,
        "bounds": {
            "minLat": min(lats),
            "maxLat": max(lats),
            "minLon": min(lons),
            "maxLon": max(lons),
        },
        "elevation": {
            "min": round(min(eles), 1),
            "max": round(max(eles), 1),
            "gain": round(gain),
        },
        "cumulative": [round(c, 1) for c in index.cum],
        "points": route,
    }

    fetch_osm()
    pois = build_pois(index)
    trails = build_trails(index)
    checkpoints = build_checkpoints(route, index, pois)

    json.dump(route_doc, open(os.path.join(DATA_DIR, "route.json"), "w"), separators=(",", ":"))
    json.dump(
        {
            "generated": "OpenStreetMap map call, filtered to the route corridor",
            "attribution": "© OpenStreetMap contributors (ODbL)",
            "maxOffsetMetres": MAX_OFFSET_M,
            "categories": pois,
        },
        open(os.path.join(DATA_DIR, "pois.json"), "w"),
        separators=(",", ":"),
    )
    json.dump(
        {
            "attribution": "\u00a9 OpenStreetMap contributors (ODbL)",
            "ways": trails,
        },
        open(os.path.join(DATA_DIR, "trails.json"), "w"),
        separators=(",", ":"),
    )
    json.dump(
        {
            "provisional": True,
            "note": (
                "Landmarks and attractions along the route, not the organiser's "
                "official checkpoints - replace before the event if they differ."
            ),
            "checkpoints": checkpoints,
        },
        open(os.path.join(DATA_DIR, "checkpoints.json"), "w"),
        indent=1,
    )

    print("route: %d pts, %.2f km, gain %d m" % (len(route), total / 1000, gain))
    for cat, items in sorted(pois.items()):
        print("  %-8s %d" % (cat, len(items)))
    print("  %-8s %d ways" % ("trails", len(trails)))
    print("checkpoints: %d" % len(checkpoints))


if __name__ == "__main__":
    main()
