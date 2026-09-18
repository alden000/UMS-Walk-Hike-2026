#!/usr/bin/env python3
"""Render the PWA app icons as PNGs.

No image library is assumed to be available, so this rasterises a small
signed-distance scene by hand and writes the PNG with zlib + struct.
The artwork is the route loop drawn over a dark rounded tile.

Run:  python3 tools/make_icons.py
"""
import math
import os
import struct
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ICON_DIR = os.path.join(os.path.dirname(HERE), "icons")

BG = (13, 20, 18)
BG_EDGE = (18, 32, 28)
ROUTE = (255, 90, 60)
DONE = (53, 211, 154)
DOT = (255, 255, 255)

# A stylised loop (unit square coordinates) echoing the MacRitchie route shape.
LOOP = [
    (0.50, 0.14), (0.68, 0.18), (0.80, 0.31), (0.82, 0.48), (0.74, 0.63),
    (0.60, 0.72), (0.52, 0.84), (0.38, 0.86), (0.25, 0.77), (0.20, 0.61),
    (0.24, 0.44), (0.32, 0.30), (0.40, 0.19), (0.50, 0.14),
]


def seg_distance(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    seg = dx * dx + dy * dy
    t = 0.0 if seg == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / seg))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy)), t


def path_distance(px, py, pts):
    """Distance to the polyline, plus how far along it the nearest point sits."""
    lengths = [math.dist(pts[i], pts[i + 1]) for i in range(len(pts) - 1)]
    total = sum(lengths)
    best, best_along, run = 1e9, 0.0, 0.0
    for i in range(len(pts) - 1):
        d, t = seg_distance(px, py, *pts[i], *pts[i + 1])
        if d < best:
            best, best_along = d, (run + t * lengths[i]) / total
        run += lengths[i]
    return best, best_along


def blend(base, colour, alpha):
    return tuple(round(b + (c - b) * alpha) for b, c in zip(base, colour))


def rounded_alpha(x, y, size, radius, feather):
    """Coverage of a rounded square, anti-aliased at the edge."""
    half = size / 2
    dx = abs(x - half) - (half - radius)
    dy = abs(y - half) - (half - radius)
    dx, dy = max(dx, 0.0), max(dy, 0.0)
    d = math.hypot(dx, dy) - radius
    return max(0.0, min(1.0, 0.5 - d / feather))


def render(size, maskable=False):
    # a maskable icon must keep its artwork inside the safe circle (80%)
    inset = 0.14 if maskable else 0.0
    radius = size * (0.5 if maskable else 0.235)
    feather = max(1.2, size / 96)
    stroke = size * 0.052
    dot_r = size * 0.072

    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            px, py = x + 0.5, y + 0.5
            cover = rounded_alpha(px, py, size, radius, feather)
            if cover <= 0:
                row += bytes((0, 0, 0, 0))
                continue

            # subtle vertical gradient on the tile
            g = py / size
            pixel = blend(BG_EDGE, BG, g)

            u = (px / size - 0.5) / (1 - 2 * inset) + 0.5
            v = (py / size - 0.5) / (1 - 2 * inset) + 0.5
            d, along = path_distance(u, v, LOOP)
            d *= size

            edge = max(0.0, min(1.0, (stroke / 2 - d) / feather + 0.5))
            if edge > 0:
                # the first third of the loop reads as "already walked"
                colour = DONE if along < 0.34 else ROUTE
                pixel = blend(pixel, colour, edge)

            # position dot at the start of the loop
            dd = math.hypot((u - LOOP[0][0]) * size, (v - LOOP[0][1]) * size)
            ring = max(0.0, min(1.0, (dot_r - dd) / feather + 0.5))
            if ring > 0:
                pixel = blend(pixel, DOT, ring)

            a = round(cover * 255)
            row += bytes((*pixel, a))
        rows.append(bytes(row))
    return rows


def write_png(path, rows, size):
    raw = b"".join(b"\x00" + r for r in rows)

    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw, 9))
           + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(png)
    print("wrote %s (%d bytes)" % (os.path.basename(path), len(png)))


def main():
    os.makedirs(ICON_DIR, exist_ok=True)
    for size in (192, 512):
        write_png(os.path.join(ICON_DIR, "icon-%d.png" % size), render(size), size)
    write_png(os.path.join(ICON_DIR, "icon-maskable-512.png"), render(512, maskable=True), 512)


if __name__ == "__main__":
    main()
