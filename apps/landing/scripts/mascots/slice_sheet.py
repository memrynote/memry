"""Slice the mascots/all.png icon sheet into individual transparent PNGs.

Approach: within manually chosen row bands (icon area, excluding label text),
find dark-pixel column clusters, then grow each cluster's bbox vertically
until a blank gap (so labels/headers are never included). Background is
alpha-keyed with a soft ramp to keep hand-drawn anti-aliased edges.
"""
import os
import sys
import numpy as np
from PIL import Image, ImageDraw

SRC = sys.argv[1]
OUT = sys.argv[2]
os.makedirs(OUT, exist_ok=True)

img = Image.open(SRC).convert('RGB')
W, H = img.size
a = np.asarray(img, dtype=np.int16)
bg = np.median(a[0:20, 0:20].reshape(-1, 3), axis=0)
dist = np.abs(a - bg).sum(axis=2)  # Manhattan distance from background
mask = dist > 60

# (y0, y1) bands cover icon bodies only; labels sit below each band.
ROWS = [
    (100, 248, ['notes', 'tasks', 'journal', 'calendar', 'inbox']),
    (345, 498, ['student', 'researchers', 'privacy-first', 'maker', 'adhd-brain']),
    (595, 706, ['change-log', 'roadmap', 'settings', 'help', 'feedback']),
    (805, 906, ['search', 'filter', 'favorite', 'share', 'lock', 'more']),
]

GAP_X = 30        # merge column runs closer than this (px)
GAP_Y = 8         # vertical growth stops at a blank gap taller than this
MIN_PIXELS = 60   # discard noise clusters
PAD = 6

def column_clusters(band):
    colsum = band.sum(axis=0)
    xs = np.where(colsum > 0)[0]
    if len(xs) == 0:
        return []
    runs = []
    start = prev = xs[0]
    for x in xs[1:]:
        if x - prev > GAP_X:
            runs.append((start, prev))
            start = x
        prev = x
    runs.append((start, prev))
    return [(x0, x1) for x0, x1 in runs
            if band[:, x0:x1 + 1].sum() >= MIN_PIXELS]

def grow_vertical(x0, x1, y0, y1):
    """Union of row-runs (gap tolerance GAP_Y) that overlap the band."""
    rows_any = mask[:, x0:x1 + 1].any(axis=1)
    ys = np.where(rows_any)[0]
    runs = []
    start = prev = ys[0]
    for y in ys[1:]:
        if y - prev > GAP_Y:
            runs.append((start, prev))
            start = y
        prev = y
    runs.append((start, prev))
    top, bot = None, None
    for r0, r1 in runs:
        if r1 >= y0 and r0 <= y1:  # overlaps band
            top = r0 if top is None else min(top, r0)
            bot = r1 if bot is None else max(bot, r1)
    return top, bot

def save_crop(name, x0, y0, x1, y1):
    x0, y0 = max(0, x0 - PAD), max(0, y0 - PAD)
    x1, y1 = min(W, x1 + PAD + 1), min(H, y1 + PAD + 1)
    crop = a[y0:y1, x0:x1]
    d = np.abs(crop - bg).sum(axis=2)
    alpha = np.clip((d - 15) * 255.0 / (70 - 15), 0, 255).astype(np.uint8)
    rgba = np.dstack([crop.astype(np.uint8), alpha])
    Image.fromarray(rgba, 'RGBA').save(os.path.join(OUT, name + '.png'))
    return (x1 - x0, y1 - y0)

results = []
for y0, y1, labels in ROWS:
    clusters = column_clusters(mask[y0:y1])
    if len(clusters) != len(labels):
        print(f'ERROR band y={y0}-{y1}: expected {len(labels)} clusters, '
              f'got {len(clusters)}: {clusters}')
        sys.exit(1)
    for (x0, x1), label in zip(clusters, labels):
        top, bot = grow_vertical(x0, x1, y0, y1)
        w, h = save_crop(label, x0, top, x1, bot)
        results.append((label, w, h))
        print(f'{label:14s} {w}x{h}  x={x0}-{x1} y={top}-{bot}')

# Contact sheet on split light/dark background to QA cropping + transparency
cols, cell = 6, 190
rows_n = (len(results) + cols - 1) // cols
sheet = Image.new('RGB', (cols * cell, rows_n * cell), '#faf1e6')
drw = ImageDraw.Draw(sheet)
for i in range(rows_n):
    drw.rectangle([0, i * cell + cell // 2, cols * cell, (i + 1) * cell], fill='#3a3a3a')
for i, (label, w, h) in enumerate(results):
    icon = Image.open(os.path.join(OUT, label + '.png'))
    icon.thumbnail((cell - 40, cell - 40))
    cx = (i % cols) * cell + (cell - icon.width) // 2
    cy = (i // cols) * cell + (cell - icon.height) // 2
    sheet.paste(icon, (cx, cy), icon)
    drw.text(((i % cols) * cell + 8, (i // cols) * cell + 4), label, fill='#888888')
sheet.save(os.path.join(OUT, '_contact.png'))
print(f'\n{len(results)} icons -> {OUT}')
