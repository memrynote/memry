"""Synthesize 3 structure-section mascots (folder-tags, projects, links-graph)
in the hand-drawn sheet style: wobbly ink strokes drawn at 4x then downscaled,
with exactly one terracotta accent each. Mirrors synth_wobble.py calibration.

Usage: python synth_structure.py <public/mascots> <qa-outdir>
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


def ellipse_pts(cx, cy, rx, ry, step=12):
    return [(cx + rx * math.cos(math.radians(a)), cy + ry * math.sin(math.radians(a)))
            for a in range(0, 361, step)]


def trim(a, b, ra, rb):
    """Endpoints of the a->b segment trimmed to each node's perimeter."""
    ax, ay = a
    bx, by = b
    dx, dy = bx - ax, by - ay
    L = math.hypot(dx, dy) or 1.0
    ux, uy = dx / L, dy / L
    return [(ax + ux * ra, ay + uy * ra), (bx - ux * rb, by - uy * rb)]


def new_canvas():
    im = Image.new('RGBA', (CANVAS * S, CANVAS * S), (0, 0, 0, 0))
    return im, ImageDraw.Draw(im)


def finish(im, name):
    small = im.resize((CANVAS, CANVAS), Image.LANCZOS)
    small.save(os.path.join(MASCOTS, name))
    print('saved', name)


# ---------- folder-tags: file folder + terracotta tag with grommet ----------
im, d = new_canvas()
# folder outline: left tab (x20-38 @ y34) sloping to the body top (y42)
folder = [(20, 34), (38, 34), (44, 42), (78, 42), (78, 74), (20, 74)]
stroke(d, folder, seed=11, close=True)
# terracotta diamond tag hanging over the folder's front-right corner
tag = [(66, 44), (80, 56), (66, 68), (52, 56)]
fill_poly(d, tag, seed=12)
# grommet eyelet near the tag's top corner (ink ring reads as the string hole)
gx, gy, gr = 66, 50, 3.0
d.ellipse([(gx - gr) * S, (gy - gr) * S, (gx + gr) * S, (gy + gr) * S],
          outline=INK, width=int(2.1 * S))
finish(im, 'folder-tags.png')

# ---------- projects: three stacked layer plates, top one terracotta ----------
im, d = new_canvas()
plates = [(28, TERRA, 'fill', 21), (48, INK, 'line', 22), (68, INK, 'line', 23)]
for cy, color, mode, seed in plates:
    plate = [(48, cy - 9), (75, cy), (48, cy + 9), (21, cy)]
    if mode == 'fill':
        fill_poly(d, plate, color=color, seed=seed)
    else:
        stroke(d, plate, color=color, seed=seed, close=True)
finish(im, 'projects.png')

# ---------- links-graph: three connected nodes, one terracotta ----------
im, d = new_canvas()
n1, r1 = (26, 34), 8       # ink outline node
n2, r2 = (72, 32), 7       # terracotta filled node
n3, r3 = (48, 72), 8       # ink outline node
# edges trimmed to node perimeters (drawn first, nodes cover the ends)
stroke(d, trim(n1, n2, r1, r2), seed=31)
stroke(d, trim(n1, n3, r1, r3), seed=32)
stroke(d, trim(n2, n3, r2, r3), seed=33)
stroke(d, ellipse_pts(*n1, r1, r1), seed=34, close=True)
stroke(d, ellipse_pts(*n3, r3, r3), seed=35, close=True)
fill_poly(d, ellipse_pts(*n2, r2, r2), seed=36)
finish(im, 'links-graph.png')

# ---------- QA contact sheet: new icons beside real ones, light + dark + zoom ----------
new = ['folder-tags.png', 'projects.png', 'links-graph.png']
refs = ['calendar.png', 'lock.png', 'more.png', 'roadmap.png']
names = new + refs
cell = 170
qa = Image.new('RGB', (len(names) * cell, 3 * cell), '#faf1e6')
dd = ImageDraw.Draw(qa)
dd.rectangle([0, cell, len(names) * cell, 2 * cell], fill='#3a3a3a')       # dark row
dd.rectangle([0, 2 * cell, len(names) * cell, 3 * cell], fill='#faf1e6')   # zoom row
for i, n in enumerate(names):
    icon = Image.open(os.path.join(MASCOTS, n)).convert('RGBA')
    for row in (0, 1):
        t = icon.copy()
        t.thumbnail((cell - 46, cell - 46))
        qa.paste(t, (i * cell + (cell - t.width) // 2, row * cell + (cell - t.height) // 2), t)
    if i < len(new):  # 4x NEAREST zoom of the new icons only
        z = icon.resize((icon.width * 1, icon.height * 1))
        z = icon.resize((int(icon.width * 1.4), int(icon.height * 1.4)), Image.NEAREST)
        qa.paste(z, (i * cell + (cell - z.width) // 2, 2 * cell + (cell - z.height) // 2), z)
qa.save(os.path.join(QA, '_structure_qa.png'))
print('saved _structure_qa.png ->', QA)
