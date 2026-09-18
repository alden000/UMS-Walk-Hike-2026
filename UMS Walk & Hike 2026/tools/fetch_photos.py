#!/usr/bin/env python3
"""Download the checkpoint photos from Wikimedia Commons.

Only freely-licensed files are used, and each one's credit and licence are
written into data/photos.json so the popup can show the attribution the licence
requires. Re-run to refresh.

Run:  python3 tools/fetch_photos.py
"""
import json
import os
import re
import time
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT_DIR = os.path.join(ROOT, "photos")
DATA = os.path.join(ROOT, "data", "photos.json")
API = "https://commons.wikimedia.org/w/api.php"
WIDTH = 480  # enough for a popup on a phone, small enough to precache

# checkpoint id -> Commons file
WANTED = {
    "cp3": "File:Tree Top Walk at MacRitchie, Singapore 1.jpg",
    "cp6": "File:Jelutong Tower 1.jpg",
    "cp11": "File:MacRitchie Reservoir Park.jpg",
}

# Checkpoints whose photos came from Flickr's Creative Commons pool, found via
# Openverse (https://openverse.org) rather than Commons. They are checked into
# photos/ directly and their credits live in data/photos.json, because Flickr
# needs an API key to re-fetch. Recorded here so the provenance is not lost.
#
#   cp2   Ranger station            pslim                 CC BY-NC-SA 2.0
#   cp4   View from the TreeTop Walk Eustaquio Santimano  CC BY-NC-SA 2.0
#   cp7   Syonan Jinja remains      sunriseOdyssey        CC BY-SA 2.0
#   cp12  MacRitchie boardwalk      Jnzl's Photos         CC BY 2.0
#
# Every candidate was opened and compared against the landmark before use: a
# "Lim Bo Seng Memorial" result turned out to be the Esplanade Park monument
# rather than the MacRitchie grave, and several others were selfies or
# undergrowth, so those checkpoints were left without a photo.


def strip_html(text):
    return re.sub(r"<[^>]+>", "", text or "").strip()


def fetch(title):
    params = {
        "action": "query", "format": "json", "titles": title,
        "prop": "imageinfo", "iiprop": "url|extmetadata", "iiurlwidth": str(WIDTH),
    }
    url = API + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": "ums-walk-hike-2026/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = json.load(r)
    page = next(iter(data["query"]["pages"].values()))
    info = page["imageinfo"][0]
    meta = info.get("extmetadata", {})
    return {
        "thumb": info["thumburl"],
        "page": info["descriptionurl"],
        "credit": strip_html(meta.get("Artist", {}).get("value", "Unknown")),
        "licence": strip_html(meta.get("LicenseShortName", {}).get("value", "")),
    }


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    out = {}
    for cp_id, title in WANTED.items():
        time.sleep(1.5)          # Commons rate-limits a burst of requests
        info = fetch(title)
        name = "%s.jpg" % cp_id
        req = urllib.request.Request(info["thumb"], headers={"User-Agent": "ums-walk-hike-2026/1.0"})
        with urllib.request.urlopen(req, timeout=60) as r:
            blob = r.read()
        with open(os.path.join(OUT_DIR, name), "wb") as f:
            f.write(blob)
        out[cp_id] = {
            "file": "photos/" + name,
            "credit": info["credit"],
            "licence": info["licence"],
            "source": info["page"],
        }
        print("%-6s %-7s %6.1f KB  %s / %s" % (cp_id, name, len(blob) / 1024,
                                               info["credit"][:26], info["licence"]))

    with open(DATA, "w") as f:
        json.dump({
            "note": "Freely-licensed photos from Wikimedia Commons; credit is required by the licence.",
            "photos": out,
        }, f, indent=1)
    print("wrote", os.path.relpath(DATA, ROOT))


if __name__ == "__main__":
    main()
