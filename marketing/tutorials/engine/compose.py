"""Take -> YouTube film: wallpaper, rounded window, eased auto-zoom from the recorder's marks,
narration placed on its cue, a quiet synthesized bed that ducks under the voice, and captions.

    uv run --with pillow --with numpy --with scipy python engine/compose.py <tutorial-dir>
Reads out/take/ and vo/, writes out/<slug>.mp4, .srt and .chapters.txt.
"""
import json, os, subprocess, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.abspath(sys.argv[1])
take = os.path.join(HERE, 'out', 'take')
base_out = os.path.join(HERE, 'out', os.path.basename(HERE))
out = base_out + '.mp4'
N = json.load(open(os.path.join(HERE, 'narration.json')))
TL = json.load(open(os.path.join(take, 'timeline.json')))
EV = json.load(open(os.path.join(take, 'events.json')))

SW, SH, DPR = 3200, 1800, 2
OW, OH, FPS = 1920, 1080, 60
WW, WH = 1760, 990
WX, WY = (OW - WW) // 2, (OH - WH) // 2
R = 18
RAMP = 0.8
SR = 48000

# ------------------------------------------------------------------ picture
segments, cur = [], None
for e in EV:
    if e['type'] == 'zoom':
        if cur: cur['t1'] = e['t']; segments.append(cur)
        cur = {'t0': e['t'], 'x': e['x'], 'y': e['y'], 'z': e['z']}
    elif e['type'] == 'unzoom' and cur:
        cur['t1'] = e['t']; segments.append(cur); cur = None
if cur: cur['t1'] = 1e9; segments.append(cur)


def ease(k):
    k = min(1, max(0, k))
    return k * k * (3 - 2 * k)


def camera(t):
    z, cx, cy = 1.0, SW / 2, SH / 2
    for s in segments:
        a = ease((t - s['t0']) / RAMP) * ease((s['t1'] + RAMP * 0.5 - t) / RAMP)
        if a > 0:
            z = 1 + (s['z'] - 1) * a
            cx = SW / 2 + (s['x'] * DPR - SW / 2) * a
            cy = SH / 2 + (s['y'] * DPR - SH / 2) * a
    w, h = SW / z, SH / z
    return w, h, min(max(cx, w / 2), SW - w / 2), min(max(cy, h / 2), SH - h / 2)


yy, xx = np.mgrid[0:OH, 0:OW]
g = ((xx / OW) * 0.6 + (yy / OH) * 0.4)[..., None]
bg = Image.fromarray((np.array([246, 214, 186]) * (1 - g) + np.array([236, 120, 64]) * g).astype(np.uint8))
mask = Image.new('L', (WW, WH), 0)
ImageDraw.Draw(mask).rounded_rectangle((0, 0, WW - 1, WH - 1), R, fill=255)
shadow = Image.new('L', (OW, OH), 0)
ImageDraw.Draw(shadow).rounded_rectangle((WX, WY + 14, WX + WW, WY + WH + 14), R, fill=110)
base = Image.composite(Image.new('RGB', (OW, OH), (60, 30, 10)), bg, shadow.filter(ImageFilter.GaussianBlur(28)))

video_tmp = base_out + '.video.mp4'
dec = subprocess.Popen(['ffmpeg', '-loglevel', 'error', '-i', os.path.join(take, 'take.mp4'), '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], stdout=subprocess.PIPE)
enc = subprocess.Popen(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{OW}x{OH}', '-r', str(FPS), '-i', '-',
                        '-c:v', 'libx264', '-crf', '17', '-preset', 'medium', '-pix_fmt', 'yuv420p', video_tmp], stdin=subprocess.PIPE)
# Title and end cards (engine/card.mjs): transparent frames laid over the film. While a card's
# panel is fully opaque the window is not drawn at all, so a panel smaller than the window never
# shows the app around its edges; around the morphs the window sits under the panel.
cards_dir = os.path.join(HERE, 'out', 'cards')
cards = json.load(open(os.path.join(cards_dir, 'cards.json'))) if os.path.exists(os.path.join(cards_dir, 'cards.json')) else {}
def card_at(n):
    for name, c in cards.items():
        if c['frames'][0] <= n <= c['frames'][1]:
            return name, c
    return None, None
def window_hidden(name, c, t):
    if name == 'intro': return t < c['timing']['reveal']
    if name == 'outro': return t > c['timing']['start'] + 0.3
    return False

n = 0
while True:
    buf = dec.stdout.read(SW * SH * 3)
    if len(buf) < SW * SH * 3: break
    t = n / FPS
    name, c = card_at(n)
    if c and window_hidden(name, c, t):
        canvas = bg.copy()
    else:
        w, h, cx, cy = camera(t)
        win = Image.frombuffer('RGB', (SW, SH), buf).resize((WW, WH), Image.LANCZOS, box=(cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2))
        canvas = base.copy(); canvas.paste(win, (WX, WY), mask)
    if c:
        overlay = Image.open(os.path.join(cards_dir, name, f'{n:05d}.png')).convert('RGBA')
        canvas = canvas.convert('RGBA'); canvas.alpha_composite(overlay); canvas = canvas.convert('RGB')
    enc.stdin.write(canvas.tobytes()); n += 1
enc.stdin.close(); enc.wait()
total = n / FPS

# ------------------------------------------------------------------ sound
def load(path):
    raw = subprocess.check_output(['ffmpeg', '-loglevel', 'error', '-i', path, '-af', 'loudnorm=I=-16:TP=-1.5:LRA=7', '-ar', str(SR), '-ac', '1', '-f', 'f32le', '-'])
    return np.frombuffer(raw, np.float32).copy()

L = int(total * SR) + SR
voice = np.zeros(L, np.float32)
gate = np.zeros(L, np.float32)
for s in TL:
    x = load(os.path.join(HERE, 'vo', f"{s['id']}.mp3"))
    i = int(s['vo'] * SR); j = min(L, i + len(x))
    voice[i:j] += x[: j - i]; gate[i:j] = 1

# bed: slow warm pad on I-vi-IV-V in D, 70 BPM bars, gentle low-pass shimmer
t = np.arange(L) / SR
chords = [[50, 57, 62, 66], [47, 54, 59, 62], [43, 50, 55, 59], [45, 52, 57, 61]]
bar = 60 / 70 * 4
pad = np.zeros(L, np.float32)
for k, ch in enumerate(chords * int(total / bar / 4 + 2)):
    a, b = int(k * bar * SR), int((k + 1) * bar * SR + SR)
    if a >= L: break
    b = min(b, L); tt = t[a:b] - t[a]
    env = np.minimum(1, tt / 1.2) * np.minimum(1, np.maximum(0, (bar + 1 - tt)) / 1.0)
    for m in ch:
        f = 440 * 2 ** ((m - 69) / 12)
        pad[a:b] += (np.sin(2 * np.pi * f * tt) + 0.3 * np.sin(2 * np.pi * 2 * f * tt + 0.4) * np.sin(2 * np.pi * 0.2 * tt)) * env * 0.05
from scipy.signal import butter, sosfilt
pad = sosfilt(butter(2, 1800, 'low', fs=SR, output='sos'), pad).astype(np.float32)
pad /= np.max(np.abs(pad)) + 1e-9

# duck: 50 ms ahead of the voice, 350 ms release
look = int(0.05 * SR)
g2 = np.concatenate([gate[look:], np.zeros(look, np.float32)])
g2 = np.maximum(gate, g2)
sm = np.zeros_like(g2); v = 0.0
att, rel = 1 - np.exp(-1 / (0.05 * SR)), 1 - np.exp(-1 / (0.35 * SR))
for i in range(L):
    v += (g2[i] - v) * (att if g2[i] > v else rel); sm[i] = v
fade = np.minimum(1, t / 2) * np.minimum(1, np.maximum(0, total - t) / 2.5)
bed = pad * (0.16 - 0.11 * sm) * fade
mix = voice + bed

wav = base_out + '.mix.wav'
subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'f32le', '-ar', str(SR), '-ac', '1', '-i', '-', wav], input=mix.astype(np.float32).tobytes(), check=True)
# Measure, then one static gain to -14 LUFS; the limiter only catches stray peaks.
def integrated(path):
    e = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-i', path, '-af', 'ebur128', '-f', 'null', '-'], capture_output=True, text=True).stderr
    return float(e[e.rindex('I:'):].split()[1])
# Speech has a high crest factor: compress first, or the limiter eats the gain.
comp = base_out + '.comp.wav'
subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', wav, '-af', 'acompressor=threshold=-24dB:ratio=3:attack=5:release=120', comp], check=True)
wav = comp
gain = -14 - integrated(wav)
subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', video_tmp, '-i', wav, '-map', '0:v', '-map', '1:a', '-c:v', 'copy',
                '-af', f'volume={gain:.2f}dB,alimiter=limit=0.89:attack=2:release=60:level=false,aresample=48000', '-c:a', 'aac', '-b:a', '320k', '-ac', '2',
                '-shortest', out], check=True)

# ------------------------------------------------------------------ captions + chapters
def ts(x):
    h, r = divmod(x, 3600); m, s = divmod(r, 60)
    return f'{int(h):02}:{int(m):02}:{s:06.3f}'.replace('.', ',')

cues = []
for s in TL:
    a = json.load(open(os.path.join(HERE, 'vo', f"{s['id']}.json")))['alignment']
    ch, st, en = a['characters'], a['character_start_times_seconds'], a['character_end_times_seconds']
    start, buf = None, ''
    for i, c in enumerate(ch):
        if start is None and c.strip(): start = st[i]
        buf += c
        if (c in '.?!' and (i + 1 == len(ch) or ch[i + 1] == ' ')) or (c == ',' and len(buf) > 60) or i + 1 == len(ch):
            if buf.strip(): cues.append((s['vo'] + start, s['vo'] + en[i] + 0.15, buf.strip().replace(N['brand'], 'memrynote')))
            start, buf = None, ''
with open(base_out + '.srt', 'w') as f:
    for k, (a, b, txt) in enumerate(cues, 1):
        f.write(f'{k}\n{ts(a)} --> {ts(b)}\n{txt}\n\n')
titles = {s['id']: s['title'] for s in N['scenes']}
with open(base_out + '.chapters.txt', 'w') as f:
    for s in TL:
        m, sec = divmod(int(s['t']), 60)
        f.write(f"{m}:{sec:02} {titles[s['id']]}\n")
os.remove(video_tmp); os.remove(comp); os.remove(wav.replace('.comp.wav', '.mix.wav'))
print(f'{n} frames, {total:.1f}s -> {out}')
