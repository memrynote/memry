"""Compose an 'AI agent' mascot from existing sheet parts:
feedback.png speech bubble (heart removed) + adhd-brain.png sparkles.
Big sparkle stays ink-black, small star is recolored terracotta so the
icon keeps the set's one-orange-accent rule.
"""
import os
import sys
import numpy as np
from PIL import Image, ImageDraw

MASCOTS = sys.argv[1]
OUT = sys.argv[2]

def load(name):
    return np.array(Image.open(os.path.join(MASCOTS, name)).convert('RGBA'))

def components(mask):
    """8-connected components via flood fill; returns list of pixel-index arrays."""
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

def comp_info(img, comp):
    ys, xs = comp[:, 0], comp[:, 1]
    rgb = img[ys, xs, :3].astype(int)
    orange = ((rgb[:, 0] > 180) & (rgb[:, 1] > 60) & (rgb[:, 1] < 190) & (rgb[:, 2] < 120)).mean()
    return dict(n=len(comp), bbox=(xs.min(), ys.min(), xs.max(), ys.max()), orange=orange)

def extract(img, comp, pad=3):
    """Cut a component out with only its own pixels (soft 1px dilation for AA edges)."""
    x0, y0, x1, y1 = comp_info(img, comp)['bbox']
    x0, y0 = max(0, x0 - pad), max(0, y0 - pad)
    x1, y1 = min(img.shape[1] - 1, x1 + pad), min(img.shape[0] - 1, y1 + pad)
    m = np.zeros(img.shape[:2], dtype=bool)
    m[comp[:, 0], comp[:, 1]] = True
    for _ in range(2):  # dilate to keep anti-aliased fringe
        m = m | np.roll(m, 1, 0) | np.roll(m, -1, 0) | np.roll(m, 1, 1) | np.roll(m, -1, 1)
    cut = img.copy()
    cut[..., 3] = np.where(m, cut[..., 3], 0)
    return Image.fromarray(cut[y0:y1 + 1, x0:x1 + 1])

def recolor(im, rgb):
    a = np.array(im)
    a[..., 0], a[..., 1], a[..., 2] = rgb
    return Image.fromarray(a)

fb = load('feedback.png')
br = load('adhd-brain.png')

# --- feedback: bubble + heart ---
fb_comps = sorted(components(fb[..., 3] > 100), key=len, reverse=True)
for c in fb_comps[:4]:
    print('feedback comp', comp_info(fb, c))
bubble_c, heart_c = fb_comps[0], fb_comps[1]
hx0, hy0, hx1, hy1 = comp_info(fb, heart_c)['bbox']
heart_cx, heart_cy = (hx0 + hx1) // 2, (hy0 + hy1) // 2
heart_h = hy1 - hy0

# terracotta sample from heart fill
ys, xs = heart_c[:, 0], heart_c[:, 1]
rgbs = fb[ys, xs, :3].astype(int)
is_orange = (rgbs[:, 0] > 180) & (rgbs[:, 2] < 120)
terracotta = tuple(np.median(rgbs[is_orange], axis=0).astype(int))
print('terracotta =', terracotta, 'heart center =', (heart_cx, heart_cy), 'heart h =', heart_h)

# erase heart (its pixels + 3px halo)
m = np.zeros(fb.shape[:2], dtype=bool)
m[ys, xs] = True
for _ in range(3):
    m = m | np.roll(m, 1, 0) | np.roll(m, -1, 0) | np.roll(m, 1, 1) | np.roll(m, -1, 1)
bubble = fb.copy()
bubble[..., 3] = np.where(m, 0, bubble[..., 3])
bubble_im = Image.fromarray(bubble)

# --- adhd-brain: sparkles ---
br_comps = sorted(components(br[..., 3] > 100), key=len, reverse=True)
infos = [comp_info(br, c) for c in br_comps]
for i in infos[:6]:
    print('brain comp', i)
small = [(c, i) for c, i in zip(br_comps, infos) if i['n'] < len(br_comps[0])]
black_sparks = sorted([(c, i) for c, i in small if i['orange'] < 0.3],
                      key=lambda t: t[1]['n'], reverse=True)
plus_im = extract(br, black_sparks[0][0])   # bigger black sparkle
star_im = extract(br, black_sparks[1][0])   # smaller 4-point star

# --- compose ---
def scaled(im, target_h):
    r = target_h / im.height
    return im.resize((max(1, round(im.width * r)), target_h), Image.LANCZOS)

big = scaled(plus_im, round(heart_h * 1.25))
lil = recolor(scaled(star_im, round(heart_h * 0.6)), terracotta)

canvas = Image.new('RGBA', (fb.shape[1], fb.shape[0]), (0, 0, 0, 0))
canvas.paste(bubble_im, (0, 0), bubble_im)
canvas.paste(big, (heart_cx - big.width // 2 - 3, heart_cy - big.height // 2 + 1), big)
canvas.paste(lil, (heart_cx + big.width // 2 - 7, heart_cy - big.height // 2 - lil.height // 2 + 7), lil)
canvas.save(os.path.join(OUT, 'ai-agent.png'))
print('saved ai-agent.png', canvas.size)

# QA strip: feedback | ai-agent | adhd-brain on cream + dark
cell = 190
strip = Image.new('RGB', (3 * cell, 2 * cell), '#faf1e6')
d = ImageDraw.Draw(strip)
d.rectangle([0, cell, 3 * cell, 2 * cell], fill='#3a3a3a')
for row in range(2):
    for i, name in enumerate(['feedback.png', 'ai-agent.png', 'adhd-brain.png']):
        p = os.path.join(MASCOTS if name != 'ai-agent.png' else OUT, name)
        im = Image.open(p)
        im.thumbnail((cell - 50, cell - 50))
        strip.paste(im, (i * cell + (cell - im.width) // 2, row * cell + (cell - im.height) // 2), im)
strip.save(os.path.join(OUT, '_ai_qa.png'))
print('saved _ai_qa.png')
