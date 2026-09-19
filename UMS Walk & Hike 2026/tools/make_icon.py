"""Build the app icon: a trail winding up through the reserve to a ridge.

Writes icons/icon.svg and icons/icon-maskable.svg. The PNGs beside them were
rasterised from these with headless Chromium at 512 and 192 px; any SVG
rasteriser will do, as the artwork uses nothing exotic.


The trail is the whole point of the icon, so it is not a hand-guessed outline.
A centreline is sampled, a width that tapers with distance is applied along its
normal, and the two offset edges are joined into one ribbon. That is what makes
it read as a path going away from you rather than as a blob.
"""

import math

BG_TOP, BG_BOT = '#16392f', '#091512'
SUN            = '#ffb648'
FAR            = '#2c7259'
RIDGE          = '#1b5744'
HILL           = '#0b2a22'
TRAIL          = '#f0e6d1'
TREE           = '#061914'
DOT, DOT_RING  = '#35d39a', '#f4fbf8'

# the scene is drawn past the 0..512 frame, so a circular mask or a wider
# camera still lands on scenery rather than on empty background
L, R = -90, 602

TRAIL_BOTTOM, TRAIL_TOP = 546, 284     # y at the near and far ends
TRAIL_WIDE, TRAIL_THIN = 44, 6         # half-widths, near and far


def centreline(t):
    """t = 0 at the walker's feet, 1 at the ridge."""
    y = TRAIL_BOTTOM + (TRAIL_TOP - TRAIL_BOTTOM) * t
    # two switchbacks that tighten with distance, as perspective would do
    x = 252 + 92 * math.sin(t * 1.5 * math.pi) * (1 - 0.55 * t)
    return x, y


def half_width(t):
    return TRAIL_THIN + (TRAIL_WIDE - TRAIL_THIN) * (1 - t) ** 1.5


def check_no_pinch(n=400):
    """A tapered ribbon folds over itself wherever it is wider than the bend it
    is going round. Rather than eyeball that, compare the half-width against the
    radius of curvature at every sample and refuse to draw a trail that pinches.
    """
    worst = 1e9
    for i in range(n + 1):
        t = i / n
        h = 1e-3
        x0, y0 = centreline(max(0.0, t - h))
        x1, y1 = centreline(t)
        x2, y2 = centreline(min(1.0, t + h))
        dx, dy = (x2 - x0) / (2 * h), (y2 - y0) / (2 * h)
        ddx, ddy = (x2 - 2 * x1 + x0) / h ** 2, (y2 - 2 * y1 + y0) / h ** 2
        speed = math.hypot(dx, dy)
        kappa = abs(dx * ddy - dy * ddx) / speed ** 3 if speed else 0
        radius = 1 / kappa if kappa > 1e-9 else 1e9
        worst = min(worst, radius / half_width(t))
    assert worst > 1.15, f'trail pinches: radius is only {worst:.2f}x the half-width'
    return worst


def ribbon(n=120):
    left, right = [], []
    for i in range(n + 1):
        t = i / n
        x, y = centreline(t)
        # normal from a finite difference along the centreline
        x2, y2 = centreline(min(1.0, t + 1e-3))
        x1, y1 = centreline(max(0.0, t - 1e-3))
        dx, dy = x2 - x1, y2 - y1
        d = math.hypot(dx, dy) or 1
        nx, ny = -dy / d, dx / d
        w = half_width(t)
        left.append((x + nx * w, y + ny * w))
        right.append((x - nx * w, y - ny * w))
    pts = left + right[::-1]
    return 'M' + ' L'.join(f'{x:.1f} {y:.1f}' for x, y in pts) + ' Z'


def conifer(cx, base, w, h):
    return (f'M{cx} {base-h} L{cx+w*.30} {base-h*.56} L{cx+w*.16} {base-h*.56} '
            f'L{cx+w*.43} {base-h*.30} L{cx+w*.24} {base-h*.30} '
            f'L{cx+w*.52} {base-h*.02} L{cx-w*.52} {base-h*.02} '
            f'L{cx-w*.24} {base-h*.30} L{cx-w*.43} {base-h*.30} '
            f'L{cx-w*.16} {base-h*.56} L{cx-w*.30} {base-h*.56} Z')


def scene():
    # the walker's position, sat on the trail where it is still wide
    dx, dy = centreline(0.34)
    return f'''
  <rect x="{L}" y="{L}" width="{R-L}" height="{R-L}" fill="url(#sky)"/>
  <circle cx="352" cy="150" r="54" fill="{SUN}"/>
  <path d="M{L} 300 L44 214 L120 262 L196 176 L276 256 L{R} 214 L{R} {R} L{L} {R} Z"
        fill="{FAR}"/>
  <path d="M{L} 340 L96 286 L188 330 L268 268 L360 322 L448 282 L{R} 330
           L{R} {R} L{L} {R} Z" fill="{RIDGE}"/>
  <path d="M{L} 404 C 80 368, 160 418, 248 396 C 336 374, 420 420, {R} 384
           L{R} {R} L{L} {R} Z" fill="{HILL}"/>
  <path d="{ribbon()}" fill="{TRAIL}"/>
  <path d="{conifer(96, 470, 150, 206)}" fill="{TREE}"/>
  <path d="{conifer(420, 436, 116, 156)}" fill="{TREE}"/>
  <circle cx="{dx:.1f}" cy="{dy:.1f}" r="27" fill="{DOT_RING}"/>
  <circle cx="{dx:.1f}" cy="{dy:.1f}" r="18.5" fill="{DOT}"/>'''


def svg(view, rounded):
    clip = ('<clipPath id="r"><rect width="512" height="512" rx="114"/></clipPath>'
            if rounded else '')
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="{view}" width="512" height="512">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="{BG_TOP}"/><stop offset="1" stop-color="{BG_BOT}"/>
    </linearGradient>{clip}
  </defs>
  <g{' clip-path="url(#r)"' if rounded else ''}>{scene()}
  </g>
</svg>'''


if __name__ == '__main__':
    import pathlib
    d = pathlib.Path(__file__).resolve().parent.parent / 'icons'
    print(f'trail clearance: {check_no_pinch():.2f}x half-width')
    (d / 'icon.svg').write_text(svg('0 0 512 512', True))
    # maskable: a wider camera on the same scene, so a circular OS crop still
    # keeps the sun, the trail, the dot and both trees inside the safe zone
    (d / 'icon-maskable.svg').write_text(svg('-58 -58 628 628', False))
    print('wrote both SVGs')
