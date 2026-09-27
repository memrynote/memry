"""Original score and sound design for the memrynote 30s explainer.

Reads timeline.js (cue sheet) and events.json (written by `node render.mjs --events`), so every
hit lands on the picture. 120 BPM, D major. The "mem-ry-note" motif is D5 A5 F#5.

    uv run --with numpy --with scipy python score.py [out.wav] [--vo]

--vo mixes the narration (narration.json + vo/, recorded by narrate.py) over the same master: the
bed is ducked bus by bus under each line and is sample-identical to the music-only cut elsewhere.
"""
import json
import re
import sys
import wave

import numpy as np
from scipy import signal
from scipy.io import wavfile

SR = 48000
TL = json.loads(open('timeline.js').read().split('=', 1)[1].strip().rstrip(';'))
EV = json.load(open('events.json'))
DUR = TL['dur']
N = int(SR * DUR)
TAIL = SR * 4
BEAT = 60 / TL['bpm']
rng = np.random.default_rng(20260926)


def hz(m):
    return 440.0 * 2 ** ((m - 69) / 12)


def ev(kind):
    return [e for e in EV if e['kind'] == kind]


def at(kind):
    return ev(kind)[0]['t']


def tt(n):
    return np.arange(n) / SR


def noise(n):
    return rng.standard_normal(n)


# ---------------------------------------------------------------- filters
def _sos(kind, fc, order=2):
    ny = SR * 0.45
    if kind == 'band':
        lo_, hi_ = max(20, fc[0]), min(ny, fc[1])
        return signal.butter(order, [lo_, hi_], 'band', fs=SR, output='sos')
    return signal.butter(order, min(max(fc, 20), ny), kind, fs=SR, output='sos')


def lp(x, fc, order=2):
    return signal.sosfilt(_sos('low', fc, order), x, axis=-1)


def hp(x, fc, order=2):
    return signal.sosfilt(_sos('high', fc, order), x, axis=-1)


def bp(x, lo_, hi_, order=2):
    return signal.sosfilt(_sos('band', (lo_, hi_), order), x, axis=-1)


def sweep(x, f0, f1, kind='low', block=256, width=1.8, shape=1.0):
    """Time-varying Butterworth, cutoff glides exponentially from f0 to f1 (state carried across blocks)."""
    n = len(x)
    out = np.zeros(n)
    zi = None
    for s in range(0, n, block):
        u = (s / max(1, n - 1)) ** shape
        fc = f0 * (f1 / f0) ** u
        sos = _sos('band', (fc / width, fc * width)) if kind == 'band' else _sos(kind, fc)
        if zi is None:
            zi = np.zeros((sos.shape[0], 2))
        out[s:s + block], zi = signal.sosfilt(sos, x[s:s + block], zi=zi)
    return out


# ---------------------------------------------------------------- oscillators / instruments
def saw(freq, n, ph0=0.0):
    f = np.broadcast_to(np.asarray(freq, float), (n,))
    dt = f / SR
    ph = (ph0 + np.cumsum(dt)) % 1.0
    y = 2 * ph - 1
    m = ph < dt
    x = ph[m] / dt[m]
    y[m] -= x + x - x * x - 1
    m = ph > 1 - dt
    x = (ph[m] - 1) / dt[m]
    y[m] -= x * x + x + x + 1
    return y


def release(t, hold, r):
    return np.clip(1 - (t - hold) / r, 0, 1) ** 2 if r > 0 else (t < hold).astype(float)


def pad(notes, dur, a=0.7, r=1.2, cutoff=1600, voices=5, det=0.14, bright_end=None, hpf=190):
    n = int((dur + r) * SR)
    t = tt(n)
    L = np.zeros(n)
    R = np.zeros(n)
    for m in notes:
        for v in range(voices):
            d = (v - (voices - 1) / 2) / ((voices - 1) / 2) * det
            s = saw(hz(m) * 2 ** (d / 12), n, rng.random())
            p = (v / (voices - 1)) * 1.6 - 0.8
            L += s * np.sqrt((1 - p) / 2)
            R += s * np.sqrt((1 + p) / 2)
    env = np.clip(t / a, 0, 1) ** 1.6 * np.where(t < dur, 1.0, release(t, dur, r))
    x = np.stack([L, R]) * env / np.sqrt(len(notes) * voices)
    if bright_end:
        return hp(np.stack([sweep(x[0], cutoff, bright_end), sweep(x[1], cutoff, bright_end)]), hpf)
    return hp(lp(x, cutoff), hpf)


def epiano(m, dur, vel=1.0):
    f = hz(m)
    n = int((dur + 1.4) * SR)
    t = tt(n)
    index = (1.0 + 1.2 * vel) * np.exp(-t * 3.2) + 0.3
    car = np.sin(2 * np.pi * f * t + index * np.sin(2 * np.pi * f * t))
    tine = np.sin(2 * np.pi * f * t + np.exp(-t * 30) * np.sin(2 * np.pi * 14 * f * t)) * np.exp(-t * 14) * 0.25 * vel
    amp = np.minimum(1, t / 0.002) * (0.62 * np.exp(-t * 1.5) + 0.38 * np.exp(-t * 0.45))
    return (car + tine) * amp * release(t, dur, 0.3) * vel


def bell(m, dur=2.6, vel=1.0):
    f = hz(m)
    n = int(dur * SR)
    t = tt(n)
    s = np.sin(2 * np.pi * f * t + 2.0 * np.exp(-t * 7) * np.sin(2 * np.pi * 2 * f * t))
    s += 0.26 * np.sin(2 * np.pi * 2 * f * t) * np.exp(-t * 3.4)
    s += 0.10 * np.sin(2 * np.pi * 4.01 * f * t) * np.exp(-t * 9)
    s += 0.30 * np.sin(2 * np.pi * 0.5 * f * t) * np.exp(-t * 2.4)
    return s * np.minimum(1, t / 0.002) * np.exp(-t * 1.5) * release(t, dur - 0.05, 0.05) * vel


def pluck(m, dur=0.9, bright=1.0, vel=1.0):
    f = hz(m)
    n = int(dur * SR)
    t = tt(n)
    s = np.zeros(n)
    for k in range(1, int(min(22, (SR * 0.45) // f)) + 1):
        s += k ** -1.3 * np.sin(2 * np.pi * k * f * t + k * 1.7) * np.exp(-t * (3.0 + 2.4 * k / bright))
    return s * np.minimum(1, t / 0.0015) * release(t, dur - 0.04, 0.04) * vel * 0.6


def bass(m, dur, vel=1.0):
    f = hz(m)
    n = int((dur + 0.12) * SR)
    t = tt(n)
    s = np.sin(2 * np.pi * f * t) + 0.22 * np.sin(2 * np.pi * 2 * f * t) + 0.06 * np.sin(2 * np.pi * 3 * f * t)
    s = np.tanh(1.5 * s) / np.tanh(1.5)
    return s * np.minimum(1, t / 0.006) * release(t, dur, 0.1) * (0.78 + 0.22 * np.exp(-t * 7)) * vel


def kick(vel=1.0, tone=47.0):
    n = int(0.5 * SR)
    t = tt(n)
    f = tone + 120 * np.exp(-t * 40) + 28 * np.exp(-t * 9)
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 7)
    click = hp(noise(n), 3500) * np.exp(-t * 320) * 0.3
    return np.tanh((body + click) * 1.25) * vel


def clap(vel=1.0):
    n = int(0.55 * SR)
    t = tt(n)
    nz = bp(noise(n), 900, 3200)
    e = np.zeros(n)
    for k, off in enumerate([0.0, 0.010, 0.021, 0.030]):
        u = np.clip(t - off, 0, None)
        e += np.where(t >= off, np.exp(-u * (190 if k < 3 else 16)), 0) * (0.75 if k < 3 else 1.0)
    return nz * e * vel * 0.8


def hat(vel=1.0, open_=False):
    n = int((0.32 if open_ else 0.07) * SR)
    t = tt(n)
    return hp(noise(n), 7800, 2) * np.exp(-t * (15 if open_ else 60)) * vel * 0.45


def shaker(vel=1.0):
    n = int(0.09 * SR)
    t = tt(n)
    return bp(noise(n), 4800, 11500) * np.minimum(1, t / 0.014) * np.exp(-t * 45) * vel * 0.32


def snare(vel=1.0):
    n = int(0.28 * SR)
    t = tt(n)
    body = np.sin(2 * np.pi * np.cumsum(185 + 60 * np.exp(-t * 40)) / SR) * np.exp(-t * 28) * 0.55
    return (body + bp(noise(n), 1600, 9000) * np.exp(-t * 22)) * vel * 0.6


def tom(f0=95.0, vel=1.0):
    n = int(0.7 * SR)
    t = tt(n)
    f = f0 * (1 + 0.7 * np.exp(-t * 22))
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 7.5) * vel


# ---------------------------------------------------------------- fx
def whoosh(dur=0.55, f0=260, f1=5200, peak=0.62, vel=1.0):
    n = int(dur * SR)
    t = tt(n)
    x = sweep(noise(n), f0, f1, 'band', width=1.7)
    u = t / dur
    env = np.where(u < peak, (u / peak) ** 2.2, np.exp(-(u - peak) / (1 - peak) * 4.5))
    return x * env * vel


def riser(dur, f0=180, f1=9000, tone_from=None, tone_to=None, vel=1.0):
    n = int(dur * SR)
    t = tt(n)
    u = t / dur
    x = sweep(noise(n), f0, f1, 'low', shape=0.7) * u ** 2
    if tone_from:
        f = hz(tone_from) * (hz(tone_to) / hz(tone_from)) ** (u ** 1.6)
        x += lp(saw(f, n) + saw(f * 1.006, n) + saw(f * 1.5, n) * 0.5, 3000) * u ** 2.4 * 0.25
    return x * vel


def boom(vel=1.0, low=30.0):
    n = int(2.6 * SR)
    t = tt(n)
    f = low + 75 * np.exp(-t * 6)
    sub = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 2.1)
    return np.tanh((sub + lp(noise(n), 420) * np.exp(-t * 5.5) * 0.45) * 1.2) * vel


def crash(vel=1.0, dur=3.0):
    n = int(dur * SR)
    t = tt(n)
    return hp(noise(n), 5200) * (np.exp(-t * 1.6) * 0.7 + np.exp(-t * 14) * 0.3) * vel * 0.3


def rev_swell(dur=0.6, notes=(74, 78, 81), vel=1.0):
    n = int(dur * SR)
    t = tt(n)
    u = t / dur
    x = sweep(noise(n), 2500, 8500, 'low') * 0.35
    for m in notes:
        x += np.sin(2 * np.pi * hz(m) * t + 0.7 * np.sin(2 * np.pi * hz(m) * 2 * t)) * 0.3
    return x * np.exp((u - 1) * 5.5) * np.minimum(1, (1 - u) * 60) * vel


def tick(f=3000.0, vel=1.0, dec=240):
    n = int(0.035 * SR)
    t = tt(n)
    return np.sin(2 * np.pi * f * t) * np.exp(-t * dec) * vel


def tock(f=950.0, vel=1.0):
    n = int(0.09 * SR)
    t = tt(n)
    return (np.sin(2 * np.pi * f * t) + 0.45 * np.sin(2 * np.pi * f * 1.51 * t)) * np.exp(-t * 55) * vel


def pop(vel=1.0, f0=380.0, f1=1100.0):
    n = int(0.08 * SR)
    t = tt(n)
    f = f0 + (f1 - f0) * (1 - np.exp(-t * 60))
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 45) * vel


def zip_up(dur=0.28, vel=1.0):
    n = int(dur * SR)
    t = tt(n)
    f = 300 * (6 ** (t / dur) )
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.sin(np.pi * t / dur) ** 2 * vel * 0.5


def scratch(dur=0.34, vel=1.0):
    n = int(dur * SR)
    t = tt(n)
    am = 0.55 + 0.45 * np.sign(np.sin(2 * np.pi * (16 + 8 * rng.random()) * t + rng.random() * 6))
    return bp(noise(n), 2200, 7500) * lp(am, 60) * np.sin(np.pi * t / dur) ** 1.5 * vel * 0.5


def glitch(dur=0.42, seed=0, vel=1.0):
    r = np.random.default_rng(seed)
    n = int(dur * SR)
    out = np.zeros(n)
    pos = 0
    while pos < n:
        seg = int(r.uniform(0.007, 0.03) * SR)
        kind = r.integers(0, 4)
        m = min(seg, n - pos)
        if kind == 0:
            step = int(r.integers(8, 48))
            out[pos:pos + m] = np.repeat(r.uniform(-1, 1, m // step + 1), step)[:m]
        elif kind == 1:
            f = r.choice([1568, 2093, 2349, 2794, 3136, 3520, 4186])
            out[pos:pos + m] = np.sign(np.sin(2 * np.pi * f * tt(m))) * 0.45
        elif kind == 2:
            out[pos:pos + m] = np.sin(2 * np.pi * r.choice([880, 1175, 1760]) * tt(m)) * 0.6
        pos += seg
    t = tt(n)
    return lp(out, 9500) * np.minimum(1, t / 0.004) * np.clip(1 - (t / dur) ** 3, 0, 1) * vel * 0.42


def lock_click(vel=1.0):
    n = int(0.7 * SR)
    t = tt(n)
    out = np.zeros(n)
    for off, g in [(0.0, 1.0), (0.034, 0.75)]:
        i = int(off * SR)
        u = tt(n - i)
        out[i:] += bp(noise(n - i), 2600, 9000) * np.exp(-u * 520) * g
        out[i:] += np.sin(2 * np.pi * 3300 * u) * np.exp(-u * 95) * 0.28 * g
    thump = np.sin(2 * np.pi * np.cumsum(62 + 70 * np.exp(-t * 32)) / SR) * np.exp(-t * 9) * 0.9
    return (out + thump) * vel


def tug(vel=1.0):
    n = int(1.0 * SR)
    t = tt(n)
    f = 55 * (1 + 0.3 * np.exp(-t * 14))
    s = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 3.6)
    s += 0.45 * np.sin(2 * np.pi * np.cumsum(2.01 * f) / SR) * np.exp(-t * 6)
    s += bp(noise(n), 500, 2400) * (np.sin(2 * np.pi * 31 * t) > 0.55) * np.exp(-t * 9) * 0.22
    return s * vel


def notif(kind, base, vel=1.0):
    if kind == 0:
        a = bell(base, 0.7, 0.8)
        b = np.concatenate([np.zeros(int(0.075 * SR)), bell(base + 5, 0.7, 0.8)])
        a = np.pad(a, (0, len(b) - len(a)))
        return (a + b) * 0.5 * vel
    if kind == 1:
        return pop(vel, 420, 1300)
    if kind == 2:
        n = int(0.26 * SR)
        t = tt(n)
        return lp(np.sign(np.sin(2 * np.pi * 165 * t)), 900) * (0.5 + 0.5 * np.sign(np.sin(2 * np.pi * 26 * t))) * np.sin(np.pi * t / 0.26) * 0.35 * vel
    x = np.zeros(int(0.2 * SR))
    for k in range(3):
        c = tick(hz(base + 12) , 0.7, 180)
        i = int(k * 0.045 * SR)
        x[i:i + len(c)] += c
    return x * vel


# ---------------------------------------------------------------- mixing buses
class Bus:
    def __init__(self):
        self.x = np.zeros((2, N + TAIL))

    def add(self, sig, t, gain=1.0, pan=0.0):
        i = int(round(t * SR))
        if sig.ndim == 1:
            sig = np.stack([sig * np.sqrt((1 - pan) / 2), sig * np.sqrt((1 + pan) / 2)]) * np.sqrt(2)
        if i < 0:
            sig = sig[:, -i:]
            i = 0
        n = min(sig.shape[1], self.x.shape[1] - i)
        if n > 0:
            self.x[:, i:i + n] += sig[:, :n] * gain


keys, lead, padb, bassb, arpb, drm, fx, chaos, last = (Bus() for _ in range(9))
verb, dly = Bus(), Bus()


def send(bus, sig, t, gain, pan=0.0, rv=0.0, dl=0.0):
    bus.add(sig, t, gain, pan)
    if rv:
        verb.add(sig, t, gain * rv, pan)
    if dl:
        dly.add(sig, t, gain * dl, pan)


# ---------------------------------------------------------------- harmony
#            start  end   pad voicing                       bass
CHORDS = [
    (6.0, 8.0, [50, 57, 61, 64, 66], 38),       # Dmaj9
    (8.0, 10.0, [47, 54, 57, 61, 62], 35),      # Bm9
    (10.0, 12.0, [43, 55, 59, 62, 66, 69], 31),  # Gmaj9
    (12.0, 14.0, [45, 57, 61, 64, 66, 71], 33),  # A6/9
    (14.0, 16.0, [42, 54, 57, 61, 64, 69], 30),  # F#m7
    (16.0, 18.0, [47, 54, 57, 61, 62, 66], 35),  # Bm9
    (18.0, 20.0, [43, 55, 59, 62, 66, 69], 31),  # Gmaj9
    (20.0, 22.0, [40, 52, 55, 59, 62, 66], 40),  # Em9
    (22.0, 24.0, [45, 57, 62, 64, 67, 69], 33),  # A7sus4
    (24.0, 26.0, [38, 50, 57, 61, 64, 66, 69], 38),  # Dmaj9
    (26.0, 28.0, [38, 50, 55, 59, 62, 66, 69], 38),  # Gmaj9/D
    (28.0, 30.0, [38, 50, 57, 61, 64, 66], 38),  # Dmaj9
]
ARP = {10.0: [62, 66, 69, 74], 12.0: [61, 64, 66, 71], 14.0: [61, 64, 69, 73], 16.0: [62, 66, 69, 73], 18.0: [62, 66, 69, 74]}

# ---------------------------------------------------------------- 0 - 1.5  the thought
send(padb, pad([50, 57, 64, 69], 1.55, a=0.9, r=0.8, cutoff=1400, hpf=110), 0.0, 0.3, rv=0.5)
send(lead, bell(74, 3.0, 0.9), 0.1, 0.17, rv=0.6, dl=0.25)
for e in ev('introWord'):
    send(fx, tock(1500 + e['k'] * 90, 0.5), e['t'], 0.09, pan=-0.2 + e['k'] * 0.12, rv=0.3)

# ---------------------------------------------------------------- 1.5 - 5.5  the noise (on the chaos bus, tape-stopped at the freeze)
F = TL['freeze']
split_pl = [71, 74, 78]
for e in ev('split'):
    k = e['k']
    send(fx, whoosh(0.46, 300, 5600, 0.72), e['t'] - 0.36, 0.33, pan=[-0.6, 0.7, -0.2][k])
    send(chaos, notif([0, 1, 0][k], [84, 88, 86][k], 1.0), e['t'], 0.26, pan=[-0.5, 0.6, -0.2][k], rv=0.35)
    send(chaos, pluck(split_pl[k], 1.4, 1.0), e['t'], 0.28, pan=[-0.3, 0.3, 0][k], rv=0.4, dl=0.3)
send(chaos, pad([47, 54, 57, 61, 62], F - 1.5 + 0.4, a=0.5, r=0.2, cutoff=900, bright_end=3600), 1.5, 0.15, rv=0.3)
t = 1.5
while t < F + 0.35:
    step = BEAT / 2 if t < TL['chaos']['start'] else BEAT / 4
    send(chaos, bass(35 if int(t / step) % 2 == 0 else 47, step * 0.7, 0.9), t, 0.2)
    send(chaos, tick(3200 if int(t / step) % 2 else 2500, 0.8, 300), t, 0.12, pan=0.35 if int(t / step) % 2 else -0.35)
    t += step
for e in ev('pop'):
    k = e['k']
    send(chaos, notif(k % 4, [85, 90, 83, 88, 92, 86][k % 6], 1.0), e['t'], 0.2, pan=float(np.clip(e['x'], -0.9, 0.9)), rv=0.3)
send(chaos, riser(F - TL['chaos']['start'] + 0.35, 200, 9000, 59, 66, 1.0), TL['chaos']['start'], 0.3)
send(chaos, boom(0.6, 36), at('where'), 0.55, rv=0.3)
# the tape-stop gets applied to the whole chaos bus below

# ---------------------------------------------------------------- 5.75 tug, 6.0 drop
send(fx, tug(1.0), at('tug'), 0.3, rv=0.25)
D0 = at('drop')
send(fx, rev_swell(0.34, (62, 69, 74), 1.0), D0 - 0.34, 0.22)
send(fx, boom(1.0, 32), D0, 0.8, rv=0.25)
send(fx, crash(0.8, 3.5), D0, 0.5, rv=0.3)
for m, g in zip([62, 69, 73, 76, 78], [1, 0.8, 0.7, 0.6, 0.55]):
    send(keys, epiano(m, 1.9, 0.9), D0, 0.2 * g, rv=0.35)
motif = [74, 81, 78]
for e in ev('syllable'):
    send(lead, bell(motif[e['k']], 2.4, 1.0), e['t'], 0.34, pan=[-0.15, 0.15, 0][e['k']], rv=0.55, dl=0.35)
for k, m in enumerate([73, 76, 81]):
    send(lead, pluck(m, 1.0, 1.2), at('tagline') + k * 0.08, 0.12, pan=-0.3 + k * 0.3, rv=0.4, dl=0.4)

# ---------------------------------------------------------------- pads, keys, bass through the rest
for s, e_, v, b in CHORDS:
    lastbar = s >= 28.0
    send(padb, pad(v[1:], e_ - s + (0.2 if not lastbar else -0.6), a=0.08 if s in (6.0, 24.0) else 0.25, r=0.9 if not lastbar else 1.2,
                   cutoff=2200 if s < 20 or s >= 24 else 1800), s, 0.5 if s < 24 else 0.62, rv=0.35)
    # keys: gentle comping in the groove, long chords elsewhere
    if 10.0 <= s < 20.0:
        for off, d, vel in [(0.0, 1.1, 0.9), (1.5 * BEAT, 0.3, 0.6), (2.5 * BEAT, 1.1, 0.75)]:
            for m in v[1:]:
                send(keys, epiano(m + 12 if m < 60 else m, d, vel), s + off, 0.075, rv=0.25)
    elif s >= 20.0:
        for m in v[1:]:
            send(keys, epiano(m + 12 if m < 57 else m, e_ - s - 0.2, 0.8), s, 0.07, rv=0.4)
    elif s == 8.0:
        for m in v[1:]:
            send(keys, epiano(m + 12 if m < 57 else m, 1.8, 0.7), s, 0.07, rv=0.4)
    # bass
    if 8.0 <= s < 20.0:
        pat = [(0.0, 0, 0.7), (1.5, 12, 0.3), (2.0, 0, 0.7), (3.5, 7, 0.3)] if s >= 10.0 else [(0.0, 0, 1.6), (3.0, 0, 0.8)]
        for off, iv, d in pat:
            send(bassb, bass(b + iv, d, 0.95), s + off * BEAT, 0.36)
    elif s >= 20.0:
        send(bassb, bass(b, e_ - s - 0.05, 0.9), s, 0.34)
    else:
        send(bassb, bass(b, e_ - s - 0.05, 0.9), s, 0.3)
    # arp sparkle in the groove
    if s in ARP:
        notes = ARP[s]
        for k in range(16):
            m = notes[[0, 1, 2, 3, 2, 1, 3, 2][k % 8]] + (12 if k % 4 == 3 else 0)
            send(arpb, pluck(m, 0.35, 0.8, 0.9 if k % 4 == 0 else 0.6), s + k * BEAT / 4, 0.07, pan=0.4 * np.sin(k), dl=0.35)

# ---------------------------------------------------------------- drums
kicks = []
def k_at(t, v=1.0, g=0.62):
    send(drm, kick(v), t, g)
    kicks.append(t)

for b in range(4):  # 8-10: heartbeat intro
    t = 8.0 + b * BEAT
    if b % 2 == 0:
        k_at(t, 0.8, 0.5)
    for s in range(4):
        send(drm, shaker(0.9 if s % 2 else 0.6), t + s * BEAT / 4, 0.3, pan=-0.3)
for b in range(20):  # 10-20: groove
    t = 10.0 + b * BEAT
    k_at(t)
    if b % 2 == 1:
        send(drm, clap(1.0), t, 0.42, rv=0.3)
    send(drm, hat(0.9, open_=(b % 4 == 3)), t + BEAT / 2, 0.3, pan=0.25)
    for s in range(4):
        send(drm, shaker(1.0 if s % 2 else 0.55), t + s * BEAT / 4, 0.26, pan=-0.3)
for b in range(7):  # 20-23.5: muffled heartbeat
    t = 20.0 + b * BEAT
    if b % 2 == 0:
        k_at(t, 0.85, 0.55)
# 23 - 24 build: snare roll into the close
t = 23.0
while t < 24.0 - 1e-6:
    u = (t - 23.0)
    step = BEAT / 4 if u < 0.5 else BEAT / 8
    send(drm, snare(0.35 + 0.65 * u), t, 0.34, rv=0.2)
    t += step

# ---------------------------------------------------------------- stations
st = TL['stations']
for k, s in enumerate(st):
    if k > 0:
        send(fx, whoosh(0.5, 240, 6000, 0.74), s - 0.47, 0.3, pan=[0, -0.5, 0.5, 0.6, 0.5][k])
    send(fx, boom(0.35, 44), s, 0.3)
    send(fx, tick(2600, 0.9, 260) + np.pad(tick(3900, 0.5, 300), (int(0.012 * SR), 0))[:int(0.035 * SR)], s + 0.12, 0.2, rv=0.2)
send(fx, whoosh(0.62, 260, 6400, 0.8), at('depart') - 0.05, 0.34, pan=-0.3)
send(fx, zip_up(0.3, 1.0), at('depart'), 0.12, pan=-0.3, rv=0.3)
send(fx, riser(1.1, 300, 7000, vel=1.0), 8.9, 0.14)
for e, m in zip(ev('line'), [74, 76, 78, 81]):
    send(lead, pluck(m, 0.9, 1.1), e['t'], 0.2, pan=0.2, rv=0.35, dl=0.35)
    send(fx, tock(1800, 0.4), e['t'], 0.05)
send(lead, bell(83, 1.4, 0.8), at('link'), 0.2, rv=0.4, dl=0.3)
send(lead, bell(88, 1.4, 0.6), at('link') + 0.06, 0.12, rv=0.4)
for e, m in zip(ev('check'), [81, 85, 88]):
    send(fx, pop(1.0, 500, 1400), e['t'], 0.2, pan=0.2)
    send(lead, bell(m, 1.6, 0.9), e['t'] + 0.02, 0.24, pan=0.2, rv=0.4, dl=0.3)
cd = at('calDrop')
send(fx, whoosh(0.26, 3000, 400, 0.85), cd - 0.24, 0.2)
send(fx, tom(88, 1.0), cd + 0.02, 0.5, rv=0.25)
send(fx, tock(700, 0.5), cd + 0.16, 0.12)
for m in [69, 73, 76]:
    send(keys, epiano(m, 0.9, 0.9), cd + 0.02, 0.09, rv=0.3)
send(fx, pop(1.0, 450, 1200), at('calPop'), 0.2, pan=0.4)
send(lead, pluck(85, 1.0, 1.1), at('calPop'), 0.16, pan=0.4, rv=0.4, dl=0.3)
for e, m in zip(ev('ink'), [78, 74, 71]):
    send(fx, scratch(0.34, 1.0), e['t'] - 0.02, 0.13, pan=0.1)
    send(keys, epiano(m, 1.0, 0.85), e['t'], 0.16, rv=0.45, dl=0.25)
send(fx, whoosh(0.22, 1200, 7000, 0.7), at('ask') - 0.1, 0.14, pan=0.4)
send(fx, pop(0.8, 600, 1500), at('ask'), 0.14, pan=0.4)
a0, a1 = at('answerStart'), at('answerEnd')
t = a0
pent = [86, 88, 91, 93, 95, 98]
while t < a1:
    send(lead, bell(int(rng.choice(pent)), 0.6, 0.5), t, 0.07, pan=float(rng.uniform(-0.6, 0.6)), rv=0.5)
    t += BEAT / 4
for e, m in zip(ev('source'), [86, 83]):
    send(fx, pop(0.9, 500, 1300), e['t'], 0.16, pan=0.3)
    send(lead, pluck(m, 0.9, 1.1), e['t'], 0.14, pan=0.3, rv=0.4, dl=0.3)
send(fx, rev_swell(0.5, (64, 71, 76), 0.9), TL['privacy']['start'] - 0.5, 0.22)

# ---------------------------------------------------------------- privacy
P0 = TL['privacy']
send(fx, boom(0.7, 30), P0['start'], 0.5, rv=0.4)
send(fx, whoosh(0.7, 5000, 180, 0.3), P0['start'], 0.22)
for e in ev('scramble'):
    send(fx, glitch(0.46, seed=e['k'] + 3, vel=1.0), e['t'], 0.2, pan=[-0.45, -0.8, -0.35, 0.4, 0.8][e['k']], rv=0.15)
L0 = at('lock')
send(fx, whoosh(0.3, 800, 5000, 0.9), L0 - 0.42, 0.12, pan=0.6)
send(fx, lock_click(1.0), L0, 0.5, pan=0.5, rv=0.3)
for m in [69, 76, 81]:
    send(lead, bell(m, 2.2, 0.8), L0 + 0.01, 0.12, pan=0.4, rv=0.5, dl=0.3)
send(fx, riser(1.05, 250, 10000, 57, 69, 1.0), 22.95, 0.22)
send(fx, whoosh(0.55, 400, 8000, 0.85), at('race') - 0.05, 0.34, pan=0.4)

# ---------------------------------------------------------------- finale
C0 = at('close')
send(fx, boom(1.0, 30), C0, 0.85, rv=0.3)
send(fx, crash(0.9, 4.0), C0, 0.5, rv=0.35)
for m, g in zip([62, 69, 73, 76, 78, 81], [1, 0.8, 0.7, 0.6, 0.55, 0.5]):
    send(keys, epiano(m, 1.8, 0.95), C0, 0.19 * g, rv=0.4)
F0, F1 = TL['fill']
send(fx, rev_swell(F1 - F0, (74, 81, 86), 1.0), F0, 0.3)
send(fx, boom(0.65, 34), F1, 0.55, rv=0.4)
for m in [86, 90, 93]:
    send(lead, bell(m, 3.0, 0.7), F1, 0.09, rv=0.7, dl=0.3)
for e in ev('syllable2'):
    send(lead, bell(motif[e['k']], 2.8, 1.0), e['t'], 0.34, pan=[-0.15, 0.15, 0][e['k']], rv=0.55, dl=0.35)
    send(keys, epiano(motif[e['k']] - 12, 1.2, 0.7), e['t'], 0.1, rv=0.4)
for k, m in enumerate([66, 69, 74, 78]):
    send(lead, pluck(m, 1.2, 1.0), at('tagline2') + k * 0.09, 0.1, pan=-0.3 + k * 0.2, rv=0.45, dl=0.4)
send(lead, bell(93, 1.8, 0.6), at('url'), 0.12, pan=0.2, rv=0.6, dl=0.35)
O0 = TL['outro']
send(fx, rev_swell(0.8, (81, 86, 90), 0.8), O0, 0.16)
send(fx, whoosh(0.8, 7000, 300, 0.25), O0 + 0.05, 0.16)
send(last, bell(86, 1.2, 0.7), 29.72, 0.16)

# ---------------------------------------------------------------- processing
def tape_stop(x, t0, dur):
    i0 = int(t0 * SR)
    n = int(dur * SR)
    tau = np.arange(n) / SR
    pos = (t0 + dur / 3 * (1 - (1 - tau / dur) ** 3)) * SR
    out = x.copy()
    idx = np.arange(x.shape[1])
    for c in range(2):
        out[c, i0:i0 + n] = np.interp(pos, idx, x[c]) * (1 - tau / dur) ** 0.6
    out[:, i0 + n:] = 0
    return out


def duck_env(times, depth=0.55, rel=0.16):
    g = np.ones(N + TAIL)
    for t in times:
        i = int(t * SR)
        n = int(rel * 3 * SR)
        u = tt(n)
        dip = depth * np.exp(-u / rel) * np.minimum(1, u / 0.004 + 0.3)
        seg = g[i:i + n]
        seg *= 1 - dip[:len(seg)]
    return g


def vault_lowpass(x):
    """Privacy: the music goes muffled behind the vault door, then opens into the close."""
    P0 = TL['privacy']
    f, times, Z = signal.stft(x, fs=SR, nperseg=2048, noverlap=1536, axis=-1)
    fc = np.full(times.shape, 20000.0)
    a = (times >= P0['start']) & (times < P0['start'] + 0.35)
    fc[a] = 20000 * (650 / 20000) ** ((times[a] - P0['start']) / 0.35)
    fc[(times >= P0['start'] + 0.35) & (times < 23.0)] = 650
    b = (times >= 23.0) & (times < 24.0)
    fc[b] = 650 * (20000 / 650) ** (((times[b] - 23.0) / 1.0) ** 2.2)
    H = 1 / np.sqrt(1 + (f[:, None] / fc[None, :]) ** 6)
    Z = Z * H[None]
    _, y = signal.istft(Z, fs=SR, nperseg=2048, noverlap=1536)
    out = np.zeros_like(x)
    m = min(out.shape[1], y.shape[1])
    out[:, :m] = y[:, :m]
    return out


def make_ir(sec=2.3, pre=0.018, seed=5):
    r = np.random.default_rng(seed)
    n = int(sec * SR)
    t = tt(n)
    ir = r.standard_normal((2, n)) * np.exp(-t * 6.9 / sec)
    dark = lp(ir, 2200)
    w = np.clip(t / sec * 1.6, 0, 1)
    ir = ir * (1 - w) * 0.55 + dark * (w + 0.45 * (1 - w))
    ir = np.concatenate([np.zeros((2, int(pre * SR))), ir], axis=1)
    return ir / np.sqrt((ir ** 2).sum(axis=1, keepdims=True))


def reverb(x, ir):
    mono = hp(x.mean(0), 180)
    return np.stack([signal.fftconvolve(mono, ir[c])[:x.shape[1]] for c in range(2)])


def pingpong(x, time=0.375, fb=0.36, reps=6):
    mono = hp(x.mean(0), 250)
    out = np.zeros_like(x)
    d = int(time * SR)
    s = mono
    for k in range(1, reps + 1):
        s = lp(s, 5200) * fb if k > 1 else lp(s, 6000) * 0.55
        c = k % 2
        out[c, k * d:] += s[:out.shape[1] - k * d]
    return out


chaos_x = tape_stop(chaos.x, F, 0.32)
dk = duck_env(kicks)
drums = vault_lowpass(drm.x)
wet = reverb(verb.x + chaos_x * 0.15, make_ir()) * 0.44
echo = pingpong(dly.x) * 1.8


def bed(g):
    """Every bus summed. g(depth_db) is the narration ducking for a bus: 1 where nobody speaks."""
    # bus balance (measured active RMS targets: pad -24, bass -17.5, keys -21, lead -18, arp -28 dB)
    music = hp(keys.x, 140) * 1.23 * g(10) + lead.x * 1.15 * g(10) + (padb.x * 0.30 * g(10) + bassb.x * 0.63 * g(7) + arpb.x * 2.2 * g(10)) * dk[None]
    return vault_lowpass(music) + drums * g(7) + fx.x * g(8) + chaos_x * 0.75 * g(12) + wet * g(9) + echo * g(12)


def master(m, comp=None, norm=None):
    """Loop seam, gentle bus compression, soft clip, peak normalize. Pass comp/norm to reuse a curve."""
    # the loop seam: settle to near silence at 30s (the last bell rings over it), fade the first frames in
    fade_end = np.clip((DUR - tt(N + TAIL)) / 0.9, 0, 1) ** 1.5
    m = m * fade_end[None] + last.x * np.clip((DUR - tt(N + TAIL)) / 0.06, 0, 1)[None]
    m = m[:, :N]
    m[:, :int(0.01 * SR)] *= np.linspace(0, 1, int(0.01 * SR))[None]
    m = hp(m - m.mean(axis=1, keepdims=True), 28)
    if comp is None:
        k = np.exp(-1 / (0.08 * SR))
        lvl = np.sqrt(signal.lfilter([1 - k], [1, -k], (m ** 2).mean(0)) + 1e-12)
        thr = 10 ** (-12 / 20)
        comp = np.where(lvl > thr, (lvl / thr) ** (1 / 1.6 - 1), 1.0)
    m = np.tanh(m * comp[None] / 0.9 * 1.05) * 0.9
    if norm is None:
        norm = 0.89 / np.abs(m).max()
    return m * norm, comp, norm


mix, comp, norm = master(bed(lambda d: 1.0))


# ---------------------------------------------------------------- narration (--vo)
KW = [([1.53512485958697, -2.69169618940638, 1.19839281085285], [1.0, -1.69065929318241, 0.73248077421585]),
      ([1.0, -2.0, 1.0], [1.0, -1.99004745483398, 0.99007225036621])]  # BS.1770 K-weighting at 48 kHz


def lufs(x, mask=None):
    """Ungated BS.1770 loudness of a (2, n) signal, optionally over a sample mask."""
    for b, a in KW:
        x = signal.lfilter(b, a, x, axis=-1)
    p = x ** 2 if mask is None else x[:, mask] ** 2
    return -0.691 + 10 * np.log10(p.mean(axis=-1).sum() + 1e-12)


def cue(expr):
    """'privacy.lock+0.1' -> seconds, read from timeline.js."""
    m = re.fullmatch(r'([a-zA-Z0-9_.]+)([+-][0-9.]+)?', expr)
    v = TL
    for k in m.group(1).split('.'):
        v = v[int(k)] if isinstance(v, list) else v[k]
    return float(v) + float(m.group(2) or 0)


def biquad(kind, f0, gain_db, q):
    """RBJ cookbook peaking EQ or high shelf."""
    A, w = 10 ** (gain_db / 40), 2 * np.pi * f0 / SR
    cw, al = np.cos(w), np.sin(w) / (2 * q)
    if kind == 'peak':
        b, a = [1 + al * A, -2 * cw, 1 - al * A], [1 + al / A, -2 * cw, 1 - al / A]
    else:
        s = 2 * np.sqrt(A) * al
        b = [A * ((A + 1) + (A - 1) * cw + s), -2 * A * ((A - 1) + (A + 1) * cw), A * ((A + 1) + (A - 1) * cw - s)]
        a = [(A + 1) - (A - 1) * cw + s, 2 * ((A - 1) - (A + 1) * cw), (A + 1) - (A - 1) * cw - s]
    return np.array(b) / a[0], np.array(a) / a[0]


def deess(x, lo=5200, hi=10000, over_db=8.0, ratio=3.0):
    band = bp(x, lo, hi)
    env = np.sqrt(lp(band ** 2, 150, order=1) + 1e-12)
    live = np.abs(x) > 1e-4
    thr = np.percentile(env[live], 60) * 10 ** (over_db / 20)
    g = lp(np.minimum(1, (thr / np.maximum(env, 1e-12)) ** (1 - 1 / ratio)), 60, order=1)
    return x - band * (1 - g)


def limit(x, ceiling_db=-4.0, rel=0.06):
    """Peak limiter on 1 ms frames: +-2 ms lookahead, instant attack, smooth release."""
    hop = SR // 1000
    n = -(-len(x) // hop)
    pk = np.abs(np.pad(x, (0, n * hop - len(x)))).reshape(n, hop).max(1)
    need = np.minimum(1, 10 ** (ceiling_db / 20) / np.maximum(pk, 1e-12))
    need = np.lib.stride_tricks.sliding_window_view(np.pad(need, 2, mode='edge'), 5).min(1)
    kr = np.exp(-1e-3 / rel)
    g, s = np.ones(n), 1.0
    for i in range(n):
        s = need[i] if need[i] < s else kr * s + (1 - kr) * need[i]
        g[i] = s
    return x * np.interp(np.arange(len(x)), np.arange(n) * hop + hop / 2, g)


def compress(x, thr_db=-28.0, ratio=3.0, knee=6.0, att=0.004, rel=0.12):
    hop = SR // 1000
    n = len(x) // hop
    lev = 10 * np.log10((x[:n * hop].reshape(n, hop) ** 2).mean(1) + 1e-12)
    o = lev - thr_db
    gr = np.where(o <= -knee / 2, 0.0, np.where(o >= knee / 2, o * (1 / ratio - 1), (1 / ratio - 1) * (o + knee / 2) ** 2 / (2 * knee)))
    ka, kr = np.exp(-1e-3 / att), np.exp(-1e-3 / rel)
    g, s = np.zeros(n), 0.0
    for i in range(n):
        k = ka if gr[i] < s else kr
        s = k * s + (1 - k) * gr[i]
        g[i] = s
    return x * np.interp(np.arange(len(x)), np.arange(n) * hop + hop / 2, 10 ** (g / 20))


def narration():
    """Place every kept take so its first sound lands on its cue; build the ducking envelope."""
    nar = json.load(open('narration.json'))
    takes = {r['id']: r for r in json.load(open('vo/takes.json'))}
    v, act, spans = np.zeros(N + TAIL), np.zeros(N + TAIL), []
    for line in nar['lines']:
        r = takes[line['id']]
        sr_, x = wavfile.read('vo/' + r['file'])
        assert sr_ == SR, r['file']
        x = x.astype(np.float64)
        env = np.sqrt(lp(x ** 2, 20, order=1).clip(0))
        voiced = env > env.max() * 10 ** (-35 / 20)
        x *= 10 ** ((-23 - lufs(np.stack([x, x]), voiced)) / 20)  # same loudness for every line before the chain
        on = cue(line['at'])
        i = int(round((on - r['lead']) * SR))
        v[i:i + len(x)] += x
        off = (i + len(x)) / SR
        spans.append((line['id'], on, off))
        # duck in over 60 ms, fully down 50 ms before the first sound; out after the tail (350 ms default)
        rel = line.get('release', 0.35)
        j0, j1 = int((on - 0.11) * SR), int((off + rel + 0.01) * SR)
        u = np.arange(j0, j1) / SR
        e = np.minimum(np.clip((u - on + 0.11) / 0.06, 0, 1), np.clip(1 - (u - off) / rel, 0, 1))
        act[j0:j1] = np.maximum(act[j0:j1], e * e * (3 - 2 * e) * line.get('duck', 1.0))
    return v, act, spans


VOICE_LUFS = -11.5  # narration loudness over speech, in the same domain as the mastered bed (-11.7 LUFS)


def voice_chain(v, talk):
    v = hp(v, 85)
    for kind, f0, gdb, q in [('peak', 250, -2.0, 1.0), ('peak', 3200, 1.8, 0.9), ('shelf', 9000, 2.0, 0.7)]:
        b, a = biquad(kind, f0, gdb, q)
        v = signal.lfilter(b, a, v)
    v = compress(deess(v))
    v *= 10 ** ((VOICE_LUFS - lufs(np.stack([v, v])[:, :len(talk)], talk)) / 20)
    v = limit(v)
    room = make_ir(sec=0.7, pre=0.012, seed=9)
    wet = np.stack([lp(signal.fftconvolve(hp(v, 300), room[c])[:len(v)], 6000) for c in range(2)])
    return np.stack([v, v]) + wet * 10 ** (-19 / 20)


if '--vo' in sys.argv:
    voice, act, spans = narration()
    bed_d, _, _ = master(bed(lambda d: 10 ** (-d * act / 20)[None]), comp, norm)
    talk = act[:N] > 0.5
    V = voice_chain(voice, talk)[:, :N]
    ve = np.sqrt(lp(V[0] ** 2, 20, order=1).clip(0))
    sb = lambda x: bp(x, 300, 5000)  # the band that carries intelligibility
    for name, on, off in spans:
        seg = np.zeros(N, bool)
        seg[int(on * SR):int(off * SR)] = True
        seg &= ve > ve[seg].max() * 10 ** (-25 / 20)  # only where she is voicing
        band = 10 * np.log10((sb(V[0]) ** 2)[seg].mean() / (sb(bed_d.mean(0)) ** 2)[seg].mean())
        print(f'  {name:8s} {on:6.2f}-{off:6.2f}s  voice over bed {lufs(V, seg) - lufs(bed_d, seg):+5.1f} LU, speech band {band:+5.1f} dB')
    mix = bed_d + V
    tp = np.abs(signal.resample_poly(mix, 4, 1, axis=1)).max()  # true-peak estimate
    mix *= min(1.0, 0.89 / tp)
    print(f'voice {lufs(V, talk):.1f} LUFS over speech, true peak {20 * np.log10(tp):+.2f} dBFS before trim')


def stat(name, x):
    x = x[:, :N]
    e = np.sqrt(lp(x.mean(0) ** 2, 5))  # activity envelope
    act = e > 10 ** (-50 / 20)
    r = np.sqrt((x[:, act] ** 2).mean()) if act.any() else 0
    print(f'{name:7s} active-rms {20 * np.log10(r + 1e-12):6.1f} dB  peak {20 * np.log10(np.abs(x).max() + 1e-12):6.1f} dB  active {act.mean() * DUR:5.1f}s')


for name, b in [('keys', keys.x), ('lead', lead.x), ('pad', padb.x), ('bass', bassb.x), ('arp', arpb.x), ('drums', drm.x), ('fx', fx.x), ('chaos', chaos_x), ('reverb', wet), ('delay', echo)]:
    stat(name, b)

out = next((a for a in sys.argv[1:] if not a.startswith('--')), 'score.wav')
with wave.open(out, 'wb') as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes((mix.T * 32767).astype('<i2').tobytes())
print('wrote', out)
