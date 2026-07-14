"""Synthesize 2 connected-showcase mascots (reminder, home) in the hand-drawn
sheet style: wobbly ink strokes drawn at 4x then downscaled, with exactly one
terracotta accent each. Mirrors synth_wobble.py calibration.

Usage: python synth_showcase.py <public/mascots> <qa-outdir>
Icons are written into <public/mascots>; a QA contact sheet into <qa-outdir>.
"""
import math
import os
import random
import sys
from PIL import Image, ImageDraw

MASCOTS = sys.argv[1]
QA = sys.argv[2]
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
    small.save(os.path.join(MASCOTS, name))
    print('saved', name)


# ---------- reminder: bell dome + rim + orange clapper ----------
# The dome is one open stroke (flare -> shoulder -> crown -> shoulder -> flare);
# the rim closes it, the clapper hangs below as the single terracotta accent.
im, d = new_canvas()
stroke(d, [(25, 65), (29, 57), (31, 47), (35, 37), (42, 30),
           (48, 28), (54, 30), (61, 37), (65, 47), (67, 57), (71, 65)], seed=51)
stroke(d, [(23, 65), (73, 65)], seed=52)          # rim
stroke(d, [(48, 23), (48, 28)], width=3.0, seed=53)  # crown nub — must touch the dome
d.ellipse([(48 - 5.2) * S, (74 - 5.2) * S, (48 + 5.2) * S, (74 + 5.2) * S], fill=TERRA)
finish(im, 'reminder.png')

# ---------- home: roof + walls + orange door ----------
im, d = new_canvas()
stroke(d, [(14, 49), (48, 21), (82, 49)], seed=61)   # roof
stroke(d, [(24, 43), (24, 80)], seed=62)             # left wall
stroke(d, [(72, 43), (72, 80)], seed=63)             # right wall
stroke(d, [(22, 80), (74, 80)], seed=64)             # floor
fill_poly(d, rrect(40, 56, 56, 78.2, 2.6), seed=65)  # door — meets the floor, never crosses it
finish(im, 'home.png')

# QA sheet vs real mascots — cream row, dark row, and a 4x NEAREST zoom row
names = ['reminder.png', 'home.png', 'calendar.png', 'lock.png', 'cli.png']
cell = 170
qa = Image.new('RGB', (len(names) * cell, 2 * cell), '#faf1e6')
d = ImageDraw.Draw(qa)
d.rectangle([0, cell, len(names) * cell, 2 * cell], fill='#3a3a3a')
for row in range(2):
    for i, n in enumerate(names):
        icon = Image.open(os.path.join(MASCOTS, n))
        icon.thumbnail((cell - 46, cell - 46))
        qa.paste(icon, (i * cell + (cell - icon.width) // 2, row * cell + (cell - icon.height) // 2), icon)
qa.save(os.path.join(QA, '_showcase_qa.png'))

zoom = Image.new('RGB', (2 * 96 * 4, 96 * 4), '#faf1e6')
for i, n in enumerate(('reminder.png', 'home.png')):
    icon = Image.open(os.path.join(MASCOTS, n)).convert('RGBA')
    big = icon.resize((96 * 4, 96 * 4), Image.NEAREST)
    zoom.paste(big, (i * 96 * 4, 0), big)
zoom.save(os.path.join(QA, '_showcase_zoom.png'))

small = Image.new('RGB', (2 * 48, 48), '#faf1e6')
for i, n in enumerate(('reminder.png', 'home.png')):
    icon = Image.open(os.path.join(MASCOTS, n)).convert('RGBA')
    icon.thumbnail((32, 32), Image.LANCZOS)
    small.paste(icon, (i * 48 + 8, 8), icon)
small.resize((2 * 48 * 4, 48 * 4), Image.NEAREST).save(os.path.join(QA, '_showcase_32px.png'))
print('saved _showcase_qa.png, _showcase_zoom.png, _showcase_32px.png')
