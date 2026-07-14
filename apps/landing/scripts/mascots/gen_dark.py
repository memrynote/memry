"""Generate dark-theme mascot variants: ink pixels -> landing dark ink (#bcbab6),
terracotta accents kept. Alpha (stroke texture) is preserved untouched.
"""
import os
import sys
import numpy as np
from PIL import Image, ImageDraw

SRC = sys.argv[1]                 # public/mascots
DST = os.path.join(SRC, 'dark')
os.makedirs(DST, exist_ok=True)
SKIP = {'all.png', 'more-aio.png'}
DARK_INK = (188, 186, 182)        # --color-ink dark: #bcbab6

names = sorted(f for f in os.listdir(SRC)
               if f.endswith('.png') and f not in SKIP and os.path.isfile(os.path.join(SRC, f)))
for name in names:
    a = np.array(Image.open(os.path.join(SRC, name)).convert('RGBA'))
    r, g, b = (a[..., i].astype(int) for i in range(3))
    # terracotta-ish pixels: warm, clearly red>blue
    orange = (r > 120) & ((r - b) > 45) & ((r - g) > 20)
    out = a.copy()
    for i, v in enumerate(DARK_INK):
        ch = out[..., i]
        ch[~orange] = v
    Image.fromarray(out).save(os.path.join(DST, name))
print(f'{len(names)} dark variants -> {DST}')

# QA: light + dark rows on their real paper colors
cols = ['student.png', 'notes.png', 'inbox.png', 'ai-agent.png', 'desktop.png',
        'web-clipper.png', 'roadmap.png', 'favorite.png']
cell = 150
qa = Image.new('RGB', (len(cols) * cell, 2 * cell), '#fdf8f0')
d = ImageDraw.Draw(qa)
d.rectangle([0, cell, len(cols) * cell, 2 * cell], fill='#181919')
for row, folder in enumerate([SRC, DST]):
    for i, n in enumerate(cols):
        im = Image.open(os.path.join(folder, n))
        im.thumbnail((cell - 40, cell - 40))
        qa.paste(im, (i * cell + (cell - im.width) // 2, row * cell + (cell - im.height) // 2), im)
qa.save(os.path.join(sys.argv[2], '_dark_qa.png'))
print('saved _dark_qa.png')
