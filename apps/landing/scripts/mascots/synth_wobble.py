"""Synthesize 4 download-dropdown mascots (desktop, mobile, cli, web-clipper)
in the hand-drawn sheet style: wobbly ink strokes drawn at 4x then downscaled,
terracotta accents, plus the real heart borrowed from feedback.png.
"""
import math
import os
import random
import sys
import numpy as np
from PIL import Image, ImageDraw

MASCOTS = sys.argv[1]
OUT = sys.argv[2]
S = 4               # supersample factor
INK = (43, 42, 40, 255)
TERRA = (247, 148, 80, 255)
CANVAS = 96

def densify(pts, step=2.0):
    out = [pts[0]]
    for a, b in zip(pts, pts[1:]):
        d = math.hypot(b[0] - a[0], b[1] - a[1])
        n = max(1, int(d / step))
        for i in range(1, n + 1):
            out.append((a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n))
    return out

def wobble(pts, amp=1.5, freq=0.14, seed=0):
    rnd = random.Random(seed)
    p1, p2, p3 = (rnd.uniform(0, 6.28) for _ in range(3))
    out = []
    for i, (x, y) in enumerate(pts):
        dx = amp * (math.sin(freq * i + p1) + 0.5 * math.sin(2.3 * freq * i + p2))
        dy = amp * (math.cos(1.3 * freq * i + p3) + 0.5 * math.sin(1.7 * freq * i + p1))
        out.append((x + dx, y + dy))
    return out

def stroke(draw, pts, width=3.7, color=INK, amp=1.5, seed=0, close=False):
    """Wobbly polyline at 4x with round caps/joins."""
    pts = densify([(x * S, y * S) for x, y in pts], step=2.5)
    if close:
        pts = pts + pts[:1]
    pts = wobble(pts, amp=amp * S / 4, seed=seed)
    w = width * S
    draw.line(pts, fill=color, width=int(w), joint='curve')
    for p in (pts[0], pts[-1]):
        draw.ellipse([p[0] - w / 2, p[1] - w / 2, p[0] + w / 2, p[1] + w / 2], fill=color)

def fill_poly(draw, pts, color=TERRA, seed=0, amp=0.8):
    pts = densify([(x * S, y * S) for x, y in pts], step=2.5)
    pts = wobble(pts + pts[:1], amp=amp * S / 4, seed=seed)
    draw.polygon(pts, fill=color)

def rrect(x0, y0, x1, y1, r):
    """Rounded-rect perimeter points, clockwise from top-left arc end."""
    pts = []
    def arc(cx, cy, a0, a1):
        n = 8
        for i in range(n + 1):
            a = math.radians(a0 + (a1 - a0) * i / n)
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    pts.append((x0 + r, y0))
    pts.append((x1 - r, y0))
    arc(x1 - r, y0 + r, -90, 0)
    pts.append((x1, y1 - r))
    arc(x1 - r, y1 - r, 0, 90)
    pts.append((x0 + r, y1))
    arc(x0 + r, y1 - r, 90, 180)
    pts.append((x0, y0 + r))
    arc(x0 + r, y0 + r, 180, 270)
    return pts

def new_canvas():
    im = Image.new('RGBA', (CANVAS * S, CANVAS * S), (0, 0, 0, 0))
    return im, ImageDraw.Draw(im)

def finish(im, name):
    small = im.resize((CANVAS, CANVAS), Image.LANCZOS)
    small.save(os.path.join(OUT, name))
    print('saved', name)

# real heart from feedback.png (reuse of compose_ai extraction logic, inline)
def components(mask):
    seen = np.zeros_like(mask, dtype=bool)
    comps = []
    H, W = mask.shape
    for sy, sx in zip(*np.where(mask)):
        if seen[sy, sx]:
            continue
        stack = [(sy, sx)]
        seen[sy, sx] = True
        pix = []
        while stack:
            y, x = stack.pop()
            pix.append((y, x))
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    ny, nx = y + dy, x + dx
                    if 0 <= ny < H and 0 <= nx < W and mask[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True
                        stack.append((ny, nx))
        comps.append(np.array(pix))
    return comps

fb = np.array(Image.open(os.path.join(MASCOTS, 'feedback.png')).convert('RGBA'))
heart_c = sorted(components(fb[..., 3] > 100), key=len, reverse=True)[1]
m = np.zeros(fb.shape[:2], dtype=bool)
m[heart_c[:, 0], heart_c[:, 1]] = True
for _ in range(2):
    m = m | np.roll(m, 1, 0) | np.roll(m, -1, 0) | np.roll(m, 1, 1) | np.roll(m, -1, 1)
hcut = fb.copy()
hcut[..., 3] = np.where(m, hcut[..., 3], 0)
ys, xs = np.where(m)
HEART = Image.fromarray(hcut[ys.min():ys.max() + 1, xs.min():xs.max() + 1])

def paste_heart(im, cx, cy, h):
    r = h / HEART.height
    hh = HEART.resize((round(HEART.width * r), h), Image.LANCZOS)
    big = hh.resize((hh.width * S, hh.height * S), Image.NEAREST)
    im.paste(big, ((cx - hh.width // 2) * S, (cy - hh.height // 2) * S), big)

# ---------- desktop: monitor + stand + heart on screen ----------
im, d = new_canvas()
stroke(d, rrect(10, 16, 86, 66, 8), seed=11)
stroke(d, [(42, 67), (38, 79)], seed=12)
stroke(d, [(54, 67), (58, 79)], seed=13)
stroke(d, [(30, 81), (66, 81)], seed=14)
paste_heart(im, 48, 41, 24)
finish(im, 'desktop.png')

# ---------- mobile: phone + speaker + orange home bar ----------
im, d = new_canvas()
stroke(d, rrect(30, 8, 66, 88, 9), seed=21)
stroke(d, [(43, 17), (53, 17)], width=3.0, seed=22)
fill_poly(d, rrect(41, 75, 55, 80, 2.4), seed=23)
paste_heart(im, 48, 46, 16)
finish(im, 'mobile.png')

# ---------- cli: terminal window + dots + prompt + orange cursor ----------
im, d = new_canvas()
stroke(d, rrect(8, 20, 88, 76, 8), seed=31)
d.ellipse([(17 - 2) * S, (28 - 2) * S, (17 + 2) * S, (28 + 2) * S], fill=INK)
d.ellipse([(26 - 2) * S, (28 - 2) * S, (26 + 2) * S, (28 + 2) * S], fill=TERRA)
stroke(d, [(22, 40), (34, 49), (22, 58)], seed=32)
fill_poly(d, rrect(40, 56, 56, 61, 2.2), seed=33)
finish(im, 'cli.png')

# ---------- web-clipper: scissors + dashed cut line + orange pivot ----------
im, d = new_canvas()
stroke(d, [(30, 22), (62, 74)], width=3.8, seed=41)   # blade 1
stroke(d, [(66, 22), (34, 74)], width=3.8, seed=42)   # blade 2
# handles: wobbly ellipses
def ellipse_pts(cx, cy, rx, ry):
    return [(cx + rx * math.cos(math.radians(a)), cy + ry * math.sin(math.radians(a)))
            for a in range(0, 361, 12)]
stroke(d, ellipse_pts(28, 80, 9, 7.5), width=3.5, seed=43, close=False)
stroke(d, ellipse_pts(68, 80, 9, 7.5), width=3.5, seed=44, close=False)
d.ellipse([(48 - 3.4) * S, (48 - 3.4) * S, (48 + 3.4) * S, (48 + 3.4) * S], fill=TERRA)
for y0 in (8, 18, 28):
    stroke(d, [(48, y0), (48, y0 + 5)], width=2.8, seed=45 + y0)
finish(im, 'web-clipper.png')

# QA sheet vs real mascots
names = ['desktop.png', 'mobile.png', 'cli.png', 'web-clipper.png', 'calendar.png', 'lock.png']
cell = 170
qa = Image.new('RGB', (len(names) * cell, 2 * cell), '#faf1e6')
d = ImageDraw.Draw(qa)
d.rectangle([0, cell, len(names) * cell, 2 * cell], fill='#3a3a3a')
for row in range(2):
    for i, n in enumerate(names):
        p = os.path.join(OUT if i < 4 else MASCOTS, n)
        icon = Image.open(p)
        icon.thumbnail((cell - 46, cell - 46))
        qa.paste(icon, (i * cell + (cell - icon.width) // 2, row * cell + (cell - icon.height) // 2), icon)
qa.save(os.path.join(OUT, '_dl_qa.png'))
print('saved _dl_qa.png')
