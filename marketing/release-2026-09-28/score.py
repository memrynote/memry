"""Original score and sound design for the memrynote 2026.09.28 release film.

Reads timeline.js (cue sheet) and events.json (written by `node render.mjs --events`), so every hit
lands on the picture. 120 BPM, D major. The instruments are the ones from ../explainer-30s/score.py;
the sonic logo is the same "mem-ry-note" motif, D5 A5 F#5, sung on the end card.

    uv run --with numpy --with scipy python score.py [out.wav]

Arc: a ticking intro while the reels spin, a lock on "33", a reverse swell through the dive and the
drop on the new rail. The sidebar folds into the rail as an arpeggio, every rail click and vault
switch plays on the chord (Bm9 G D, then Em9 A), and the agent restarts the house loop (Bm9 G D A);
the typing bar thins out to kick and keys, Enter brings the band back, the themes step through the
chords, the montage peaks, and everything is inhaled into the dot before the logo resolves to D.
"""
import json
import sys
import wave

import numpy as np
from scipy import signal

SR = 48000
TL = json.loads(open('timeline.js').read().split('=', 1)[1].strip().rstrip(';'))
EV = json.load(open('events.json'))
DUR = TL['dur']
N = int(SR * DUR)
TAIL = SR * 4
BEAT = 60 / TL['bpm']
rng = np.random.default_rng(20260928)


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
        return signal.butter(order, [max(20, fc[0]), min(ny, fc[1])], 'band', fs=SR, output='sos')
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


def stab(notes, dur=0.32, vel=1.0, cutoff=2600):
    """Short filtered saw chord: the theme steps and the word hits."""
    n = int((dur + 0.25) * SR)
    t = tt(n)
    x = np.zeros(n)
    for m in notes:
        for d in (-0.08, 0.0, 0.07):
            x += saw(hz(m) * 2 ** (d / 12), n, rng.random())
    x = sweep(x, cutoff * 2.2, cutoff * 0.35, 'low', shape=0.5)
    env = np.minimum(1, t / 0.003) * np.exp(-t * 7.5) * release(t, dur, 0.2)
    return x * env * vel / np.sqrt(3 * len(notes))


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
    return lp(hp(noise(n), 7800, 2), 14000) * np.exp(-t * (15 if open_ else 60)) * vel * 0.45


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
    return lp(hp(noise(n), 5200), 15000) * (np.exp(-t * 1.6) * 0.7 + np.exp(-t * 14) * 0.3) * vel * 0.3


def rev_swell(dur=0.6, notes=(74, 78, 81), vel=1.0):
    n = int(dur * SR)
    t = tt(n)
    u = t / dur
    x = sweep(noise(n), 2500, 8500, 'low') * 0.35
    for m in notes:
        x += np.sin(2 * np.pi * hz(m) * t + 0.7 * np.sin(2 * np.pi * hz(m) * 2 * t)) * 0.3
    return x * np.exp((u - 1) * 5.5) * np.minimum(1, (1 - u) * 60) * vel


def rev_crash(dur=0.55, vel=1.0):
    """A crash played backwards: swells into the downbeat it ends on."""
    n = int(dur * SR)
    t = tt(n)
    u = t / dur
    x = lp(hp(noise(n), 3000), 13000) * np.exp((u - 1) * 6.5) * np.minimum(1, (1 - u) * 90)
    return x * vel * 0.5


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


def scratch(dur=0.34, vel=1.0):
    n = int(dur * SR)
    t = tt(n)
    am = 0.55 + 0.45 * np.sign(np.sin(2 * np.pi * (16 + 8 * rng.random()) * t + rng.random() * 6))
    return bp(noise(n), 2200, 7500) * lp(am, 60) * np.sin(np.pi * t / dur) ** 1.5 * vel * 0.5


def keyclick(vel=1.0, heavy=False):
    """A laptop key: a bright plastic tick over a short low thock."""
    n = int(0.06 * SR)
    t = tt(n)
    top = bp(noise(n), 2400, 7800) * np.exp(-t * (380 if not heavy else 300))
    body = np.sin(2 * np.pi * np.cumsum(np.full(n, 260.0 if not heavy else 190.0) * (1 + 0.6 * np.exp(-t * 90))) / SR) * np.exp(-t * 70)
    return (top * 0.7 + body * (0.55 if not heavy else 0.8)) * vel


def shutter(vel=1.0):
    n = int(0.07 * SR)
    t = tt(n)
    a = bp(noise(n), 1800, 9000) * np.exp(-t * 260)
    b = np.pad(bp(noise(n), 1200, 6000) * np.exp(-t * 200), (int(0.018 * SR), 0))[:n] * 0.7
    return (a + b) * vel


def laser(dur=0.26, f0=5200.0, f1=380.0, vel=1.0):
    """The today line: a bright tone falling as it draws down the screen."""
    n = int(dur * SR)
    t = tt(n)
    f = f0 * (f1 / f0) ** (t / dur) ** 0.7
    s = np.sin(2 * np.pi * np.cumsum(f) / SR) + 0.3 * np.sin(2 * np.pi * np.cumsum(f * 2.01) / SR)
    return s * np.minimum(1, t / 0.004) * np.exp(-t * 7) * vel * 0.4


def layer(*sigs):
    """Sum one-shots of different lengths, aligned at their starts."""
    out = np.zeros(max(len(s) for s in sigs))
    for s in sigs:
        out[:len(s)] += s
    return out


def sparkle(root=86, vel=1.0, n_notes=5):
    out = np.zeros(int(1.6 * SR))
    for k in range(n_notes):
        m = root + [0, 4, 7, 11, 12, 14, 16][k % 7]
        b = bell(m, 1.2, 0.6) * 0.5 ** (k * 0.35)
        i = int(k * 0.028 * SR)
        out[i:i + len(b)] += b[:len(out) - i]
    return out * vel


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


keys, lead, padb, bassb, arpb, drm, fx, ui = (Bus() for _ in range(8))
verb, dly = Bus(), Bus()


def send(bus, sig, t, gain, pan=0.0, rv=0.0, dl=0.0):
    bus.add(sig, t, gain, pan)
    if rv:
        verb.add(sig, t, gain * rv, pan)
    if dl:
        dly.add(sig, t, gain * dl, pan)


# ---------------------------------------------------------------- harmony
#        bass root, pad voicing
CH = {
    'G': (31, [55, 59, 62, 66, 69]),      # Gmaj9
    'A': (33, [57, 61, 64, 66, 71]),      # A6/9
    'Bm': (35, [59, 62, 66, 69, 73]),     # Bm9
    'D': (38, [62, 64, 66, 69, 73]),      # Dmaj9
    'Em': (40, [55, 59, 62, 64, 66]),     # Em9
    'Asus': (33, [57, 62, 64, 67, 69]),   # A7sus4
}
O, R, V, A, L, C, B, K, M, MO, E = (TL[k] for k in ('open', 'rail', 'vaults', 'agent', 'timeline', 'calendars', 'blocks', 'tasks', 'themes', 'more', 'end'))
# one chord per bar: the intro, the rail (Bm G D) and the vaults (Em A: ii-V into the agent's vi), then the
# vi-IV-I-V loop from the agent on, and Em9 | A7sus4 into the logo
PROG = [(0, 'G'), (2, 'A'), (R['start'], 'Bm'), (R['start'] + 2, 'G'), (R['start'] + 4, 'D'), (V['start'], 'Em'), (V['start'] + 2, 'A')]
_t, _k = A['start'], 0
while _t < MO['collapse'][0] - 0.9 - 1e-6:
    PROG.append((_t, ['Bm', 'G', 'D', 'A'][_k % 4]))
    _t, _k = _t + 2, _k + 1
PROG += [(MO['collapse'][0] - 0.9, 'Em'), (MO['collapse'][0] + 0.1, 'Asus'), (E['start'], 'D')]


def chord_at(t):
    name = PROG[0][1]
    for s, c in PROG:
        if t >= s - 1e-6:
            name = c
    return CH[name]


def tones(t, octave=0):
    """Chord tones above middle C for melodic hits, sorted."""
    return sorted(m + 12 * octave for m in chord_at(t)[1])


# ---------------------------------------------------------------- where the band plays
COLLAPSE, MARK = MO['collapse'][0], E['start']
GAP = MARK - 0.125  # a sixteenth of silence before the logo lands
# (start, end, style): style decides kick / clap / hats density
SECTIONS = [
    (O['cuts'][0], O['dive'][0], 'half'),
    (R['start'], R['out'][0], 'full'),
    (V['start'], V['out'][0], 'lift'),
    (A['start'], A['out'][0], 'full'),
    (L['start'], L['out'][0], 'lift'),
    (C['start'], C['out'][0], 'full'),
    (B['start'], B['dive'][0], 'full'),
    (K['start'], K['enter'], 'type'),
    (K['enter'], K['out'][0], 'full'),
    (M['start'], M['out'][0], 'lift'),
    (MO['start'], COLLAPSE, 'peak'),
]


def style_at(t):
    for a, b, s in SECTIONS:
        if a - 1e-6 <= t < b - 1e-6:
            return s
    return None


kicks = []


def k_at(t, v=1.0, g=0.55):
    send(drm, kick(v), t, g)
    kicks.append(t)


# drums on the sixteenth grid (bars start on even seconds)
for j in range(int(round(O['cuts'][0] / (BEAT / 4))), int(COLLAPSE / (BEAT / 4) - 1e-6) + 1):
    t = j * BEAT / 4
    if t >= COLLAPSE - 1e-6:
        break
    st = style_at(t)
    pos = j % 16  # sixteenth in the bar
    if st:
        on_beat = pos % 4 == 0
        if st == 'half':
            if pos in (0, 8):
                k_at(t, 0.9, 0.55)
            if pos % 2 == 0:
                send(drm, shaker(0.7), t, 0.22, pan=-0.3)
        elif st == 'type':
            if pos in (0, 8):
                k_at(t, 0.85, 0.5)
            if pos % 2 == 1:
                send(drm, shaker(0.8), t, 0.2, pan=-0.3)
        else:
            if on_beat:
                k_at(t)
            if pos in (4, 12):
                send(drm, clap(1.0), t, 0.42, rv=0.3)
                if st == 'peak':
                    send(drm, snare(0.7), t, 0.22, rv=0.2)
            if pos % 4 == 2:
                send(drm, hat(0.9, open_=True), t, 0.2 if st == 'full' else 0.26, pan=0.25)
            send(drm, shaker(1.0 if pos % 2 else 0.55), t, 0.24 if st != 'peak' else 0.3, pan=-0.3)
            if st in ('lift', 'peak') and pos % 2 == 1:
                send(drm, hat(0.6), t, 0.16, pan=0.45)

# fills and builds
for t0, n16 in [(L['out'][0], 8), (M['out'][0] - 0.2, 8)]:  # tom run into a new section
    for k in range(n16):
        send(drm, tom(120 - k * 7, 0.8), t0 + k * BEAT / 4 * 0.5, 0.22, pan=-0.5 + k * 0.14, rv=0.2)
ROLL = COLLAPSE - 0.9
t = ROLL
while t < COLLAPSE - 1e-6:  # snare roll into the collapse
    u = (t - ROLL) / (COLLAPSE - ROLL)
    send(drm, snare(0.3 + 0.7 * u), t, 0.3, rv=0.2)
    t += BEAT / 4 if u < 0.5 else BEAT / 8
t = K['out'][0]
while t < M['start'] - 1e-6:  # the iris: a roll that ends in the room opening
    u = (t - K['out'][0]) / (M['start'] - K['out'][0])
    send(drm, snare(0.25 + 0.6 * u), t, 0.26, rv=0.25)
    t += BEAT / 8

# ---------------------------------------------------------------- bass, pads, keys, arp
BAR = 4 * BEAT
for i in range(int(DUR / BAR)):
    s = i * BAR
    same = chord_at(s + 2 * BEAT) == chord_at(s)
    # chords can change mid-bar at the end (Em9 | A7sus4): walk the half bars
    for h in range(2):
        hs = s + h * 2 * BEAT
        root, voic = chord_at(hs)
        st = style_at(hs + 0.01)
        if hs < O['cuts'][0] or hs >= COLLAPSE:
            continue
        # one pad per chord, pumping under the kick
        dur = (BAR if same else 2 * BEAT) if h == 0 else (None if same else 2 * BEAT)
        if dur:
            dur = min(dur - 0.02, COLLAPSE - hs)
            send(padb, pad(voic, dur, a=0.05 if hs in (R['start'], A['start'], M['start'], MO['start']) else 0.2, r=0.7, cutoff=2400 if st != 'type' else 1500), hs, 0.52, rv=0.35)
        # bass: syncopated root / octave figure; the typing bar only holds the root until Enter
        if st == 'type':
            if h == 0:
                send(bassb, bass(root, min(BAR, K['enter'] - hs) - 0.06, 0.9), hs, 0.3)
        elif st:
            for off, iv, d in [(0.0, 0, 0.7), (0.75, 0, 0.2), (1.5, 12, 0.2)]:
                if hs + off * BEAT < COLLAPSE:
                    send(bassb, bass(root + iv, d, 0.95), hs + off * BEAT, 0.36)
        # keys: off-beat stabs, softer while typing
        if st and st != 'half':
            for off in ((0.5, 1.5) if st == 'peak' else (1.5,)):
                for m in voic[1:]:
                    send(keys, epiano(m + 12 if m < 60 else m, 0.28, 0.75), hs + off * BEAT, 0.07 if st != 'type' else 0.05, rv=0.3)
        # arp in the lifted sections and the montage
        if st in ('lift', 'peak'):
            notes = sorted(voic[1:])
            for k in range(8):
                m = notes[[0, 1, 2, 3, 2, 1, 3, 2][k % 8] % len(notes)] + (12 if k % 4 == 3 else 0)
                tk = hs + k * BEAT / 4
                if tk < COLLAPSE:
                    send(arpb, pluck(m + 12, 0.35, 0.9, 0.9 if k % 4 == 0 else 0.6), tk, 0.07, pan=0.45 * np.sin(k + i), dl=0.35)

# intro pads: G then A, filtered, before the band
send(padb, pad(CH['G'][1], 2.0, a=0.9, r=0.4, cutoff=900, bright_end=1800), 0.0, 0.34, rv=0.5)
send(padb, pad(CH['A'][1], 1.45, a=0.1, r=0.3, cutoff=1400, bright_end=2600), 2.0, 0.4, rv=0.45)
send(bassb, bass(33, 1.4, 0.8), 2.0, 0.3)

# ---------------------------------------------------------------- open: the dot, the label, the reels, the lock
send(lead, bell(86, 2.4, 0.8), at('dot'), 0.16, rv=0.6, dl=0.3)
send(fx, boom(0.4, 38), at('dot'), 0.25, rv=0.4)
for e in ev('decode'):
    k = e['k']
    send(ui, tick(2600 + (k % 7) * 260, 0.6, 320), e['t'], 0.05, pan=-0.4 + (k % 9) * 0.1)
R0, R1 = O['reels']
send(fx, riser(R1 - R0 + 0.05, 200, 8000, 57, 69, 1.0), R0, 0.22)
for e in ev('reelTick'):
    u = (e['t'] - R0) / (R1 - R0)
    send(ui, layer(tock(900 + 1500 * u, 0.7), np.pad(tick(3400, 0.4, 300), (int(0.004 * SR), 0))), e['t'], 0.1, pan=0.35)
L0 = at('lock')
send(fx, boom(1.0, 34), L0, 0.7, rv=0.3)
send(fx, crash(0.8, 3.0), L0, 0.4, rv=0.3)
send(ui, layer(shutter(1.0), tock(1400, 0.8)), L0, 0.4, rv=0.2)
send(keys, stab(CH['A'][1], 0.4, 1.0, 3000), L0, 0.2, rv=0.35)
for k, m in enumerate([69, 73, 76]):
    send(lead, bell(m + 12, 1.8, 0.8), L0 + k * 0.03, 0.12, pan=-0.3 + k * 0.3, rv=0.55, dl=0.3)
send(lead, pluck(81, 1.2, 1.2), at('caption'), 0.12, rv=0.4, dl=0.35)
for e in ev('cut'):
    k = e['k']
    send(ui, shutter(0.9), e['t'], 0.26, pan=[-0.5, 0.5, -0.3, 0.3, 0][k % 5], rv=0.15)
    send(lead, pluck([69, 73, 76, 78, 81][k % 5] + 12, 0.5, 1.1), e['t'], 0.07, pan=0.2, dl=0.35)
send(fx, whoosh(0.4, 600, 6000, 0.7), at('textOut') - 0.1, 0.18, pan=0.3)
D0, D1 = O['dive']
send(fx, rev_crash(D1 - D0 + 0.08, 1.0), D0 - 0.08, 0.5)
send(fx, whoosh(D1 - D0, 200, 9000, 0.92), D0, 0.45)
send(fx, riser(D1 - D0, 300, 12000, 69, 81, 1.0), D0, 0.2)

# ---------------------------------------------------------------- rail: the drop, the list folds into the rail, clicks
R0 = R['start']
send(fx, boom(1.0, 31), R0, 0.85, rv=0.25)
send(fx, crash(0.9, 3.5), R0, 0.5, rv=0.3)
send(keys, stab(CH['Bm'][1], 0.5, 1.0, 3200), R0, 0.22, rv=0.35)
for m, g in zip([59, 66, 69, 73, 74], [1, 0.8, 0.7, 0.6, 0.55]):
    send(keys, epiano(m + 12, 1.6, 0.9), R0, 0.14 * g, rv=0.35)
send(fx, whoosh(0.5, 3000, 500, 0.3), at('navFold') - 0.05, 0.14, pan=0.3)
for e in ev('labelOut'):
    send(ui, tick(3800 - 180 * e['k'], 0.5, 380), e['t'], 0.04, pan=0.3 - 0.1 * e['k'])
send(fx, whoosh(0.4, 250, 2500, 0.55), at('railSlide'), 0.16, pan=-0.5)
for e in ev('iconFly'):
    send(fx, whoosh(0.22, 800, 5000, 0.7, 0.5), e['t'], 0.035, pan=-0.2)
for e in ev('iconLand'):  # the six icons land as a rising arpeggio
    k = e['k']
    ts = tones(e['t'], 1)
    send(lead, pluck(ts[k % len(ts)] + 12 * (k // len(ts)), 0.45, 1.2, 0.9), e['t'], 0.1, pan=-0.45 + 0.05 * k, rv=0.3, dl=0.3)
    send(ui, tock(1500 + 120 * k, 0.5), e['t'], 0.05, pan=-0.45)
send(fx, whoosh(0.45, 400, 3000, 0.6), at('treeUp'), 0.12, pan=0.2)
send(ui, pop(1.0, 420, 1300), at('tilePop'), 0.2, pan=-0.4)
send(lead, bell(81, 1.4, 0.8), at('tilePop'), 0.12, pan=-0.4, rv=0.5, dl=0.3)
for e in ev('badge'):
    send(ui, pop(0.7, 900, 2200), e['t'], 0.08, pan=-0.35)
send(fx, whoosh(0.65, 5000, 300, 0.3), at('pullBack'), 0.22, pan=0.1)
for e in ev('tip'):
    send(ui, tick(2600, 0.5, 300), e['t'], 0.05, pan=-0.3)
for e in ev('railClick'):
    ts = tones(e['t'], 1)
    send(ui, layer(tick(3200, 1.0, 220), tock(1300, 0.6)), e['t'], 0.22, pan=-0.35)
    send(lead, pluck(ts[e['k'] % len(ts)], 0.6, 1.2), e['t'], 0.14, pan=-0.2, rv=0.35, dl=0.35)
    send(fx, whoosh(0.3, 600, 4500, 0.35), e['t'] - 0.02, 0.1, pan=0.3)
send(ui, keyclick(1.1, True), at('cmdDown'), 0.4, pan=-0.2)
for e in ev('numFlip'):
    send(ui, tick(2400 + 260 * e['k'], 0.6, 320), e['t'], 0.06, pan=-0.35)
send(ui, keyclick(1.2, True), at('cmdPress'), 0.45, pan=-0.1)
send(keys, stab(chord_at(at('cmdPress'))[1], 0.35, 0.9, 3000), at('cmdPress'), 0.16, rv=0.35)
send(fx, whoosh(0.35, 4000, 600, 0.3), at('cmdPress'), 0.14, pan=-0.3)
send(ui, keyclick(0.8, False), at('cmdUp'), 0.25, pan=-0.2)
send(fx, whoosh(0.6, 300, 6000, 0.6), at('railOut') - 0.05, 0.3, pan=-0.6)

# ---------------------------------------------------------------- vaults: swipe, swipe, click, click
send(fx, whoosh(0.7, 400, 7000, 0.55), at('vaultIn'), 0.26, pan=0.6)
send(fx, riser(0.3, 600, 6000), at('lift'), 0.12)
send(ui, pop(0.8, 300, 900), at('lift') + 0.3, 0.12, pan=-0.3)
for e in ev('vpage'):  # the panel pages right to left
    send(fx, whoosh(0.4, 900, 5500, 0.5), e['t'], 0.12, pan=0.5)
    send(fx, whoosh(0.35, 5000, 900, 0.3), e['t'] + 0.2, 0.08, pan=-0.5)
VBELL = [74, 78, 81]  # memrynote D, Garden F#, Vocab A
for e in ev('vaultSwitch'):
    send(keys, stab(chord_at(e['t'])[1], 0.3, 0.9, 3000), e['t'], 0.16, rv=0.35)
    send(lead, bell(VBELL[e['v']], 1.6, 0.9), e['t'], 0.16, pan=-0.3 + 0.3 * e['v'], rv=0.5, dl=0.3)
    send(ui, pop(0.8, 500, 1500), e['t'], 0.1, pan=-0.5)
send(ui, tock(700, 0.6), at('drop'), 0.12, pan=-0.3)
send(fx, riser(0.45, 300, 9000, 64, 76, 1.0), at('vzoomIn') - 0.05, 0.16)
send(fx, whoosh(0.4, 400, 8000, 0.85), at('vzoomIn'), 0.2)
for e in ev('vaultClick'):
    send(ui, layer(tick(3200, 1.0, 220), tock(1100, 0.7)), e['t'], 0.26, pan=-0.2)
    send(ui, sparkle(86 if e['k'] == 0 else 81, 0.8, 4), e['t'] + 0.03, 0.09, pan=-0.2)
send(fx, whoosh(0.45, 8000, 400, 0.2), at('vzoomOut'), 0.2)
send(fx, whoosh(0.6, 300, 6000, 0.6), at('vaultOut') - 0.05, 0.3, pan=-0.6)

# ---------------------------------------------------------------- agent: slides in on the loop's first bar
send(fx, boom(0.6, 36), A['start'], 0.45, rv=0.3)
send(fx, crash(0.5, 2.5), A['start'], 0.25, rv=0.3)
send(keys, stab(CH['Bm'][1], 0.4, 0.8, 3000), A['start'], 0.16, rv=0.35)
send(fx, whoosh(0.6, 300, 4200, 0.7), at('push') - 0.1, 0.16, pan=0.4)
for e in ev('substitute'):
    send(ui, scratch(0.18, 1.0), e['t'], 0.14, pan=0.3)
    ts = tones(e['t'], 1)
    send(lead, pluck(ts[2], 0.9, 1.1), e['t'] + 0.1, 0.2, pan=0.25, rv=0.35, dl=0.35)
for j, e in enumerate(ev('insert')):
    ts = tones(e['t'], 1)
    send(lead, pluck(ts[1 + j], 0.9, 1.1), e['t'], 0.2, pan=0.1 + j * 0.15, rv=0.35, dl=0.35)
    send(ui, pop(0.6, 500, 1300), e['t'], 0.08, pan=0.3)
send(ui, pop(1.0, 420, 1200), at('bar'), 0.18, pan=0.2)
send(fx, whoosh(0.3, 900, 5000, 0.8), at('bar') - 0.12, 0.14, pan=0.2)
send(fx, whoosh(0.7, 1500, 6000, 0.5), at('cursor'), 0.06, pan=0.5)
send(ui, tick(2200, 0.9, 260), at('press'), 0.2, pan=0.3)
ACC = at('accept')
send(ui, layer(tick(3200, 1.0, 220), tock(1300, 0.6)), ACC, 0.26, pan=0.3)
send(ui, sparkle(86, 1.0, 5), ACC, 0.14, pan=0.25)
for k, m in enumerate([74, 78, 81]):
    send(lead, bell(m, 2.2, 0.9), ACC + k * 0.025, 0.16, pan=-0.2 + k * 0.2, rv=0.5, dl=0.3)
send(keys, stab(CH['D'][1], 0.45, 0.9, 3400), ACC, 0.16, rv=0.35)
X0 = at('exit')
send(fx, whoosh(0.7, 3000, 300, 0.25), X0, 0.26, pan=-0.3)
send(fx, rev_swell(L['start'] - X0 - 0.05, (69, 73, 76), 0.9), X0 + 0.05, 0.22)

# ---------------------------------------------------------------- timeline
send(ui, laser(0.3, 5200, 380, 1.0), at('line'), 0.3, rv=0.35)
send(fx, boom(0.7, 36), at('line'), 0.5, rv=0.3)
send(ui, pop(1.0, 520, 1500), at('today'), 0.22, rv=0.3)
send(lead, bell(81, 1.4, 0.8), at('today'), 0.12, rv=0.5, dl=0.3)
send(fx, whoosh(0.5, 400, 7000, 0.5), at('reveal'), 0.2)
for e in ev('row'):
    k = e['k']
    ts = tones(e['t'])
    idx = k % 10  # up two octaves of the chord, and again
    m = ts[idx % len(ts)] + 12 * (1 + idx // len(ts))
    send(arpb, pluck(m, 0.3, 1.2, 0.7), e['t'], 0.06, pan=-0.6 + 1.2 * k / 27, dl=0.25)
    send(ui, tick(4200 + k * 40, 0.5, 400), e['t'], 0.035, pan=-0.6 + 1.2 * k / 27)
send(fx, whoosh(0.6, 300, 6000, 0.6), at('swing') - 0.05, 0.3, pan=-0.6)
send(fx, whoosh(0.5, 500, 7000, 0.7), at('swing') + 0.15, 0.2, pan=0.6)

# ---------------------------------------------------------------- calendars
for e in ev('provider'):
    k = e['k']
    send(drm, tom([98, 110, 123, 131][k], 1.0), e['t'], 0.34, pan=[-0.4, -0.1, 0.2, 0.45][k], rv=0.25)
    send(lead, bell([74, 78, 81, 86][k], 1.6, 0.9), e['t'], 0.16, pan=[-0.4, -0.1, 0.2, 0.45][k], rv=0.5, dl=0.3)
send(fx, whoosh(0.3, 500, 9000, 0.85), at('whipUp') - 0.02, 0.36, pan=0.1)

# ---------------------------------------------------------------- blocks
for e in ev('word'):
    k = e['k']
    send(fx, boom(0.5, 40), e['t'], 0.34, rv=0.3)
    send(keys, stab(chord_at(e['t'])[1], 0.3, 0.8, 2800), e['t'], 0.14, rv=0.3)
for e in ev('whip'):
    send(fx, whoosh(0.22, 700, 9000, 0.8), e['t'] - 0.05, 0.34, pan=0.0)
for e in ev('ink'):
    send(ui, scratch(0.26 + 0.06 * (e['k'] == 0), 1.0), e['t'], 0.13, pan=-0.2 + 0.15 * e['k'])
for e in ev('boxPop'):
    ts = tones(e['t'], 1)
    send(ui, pop(0.9, 450, 1400), e['t'], 0.14, pan=-0.4 + 0.1 * e['k'])
    send(lead, pluck(ts[e['k'] % len(ts)], 0.5, 1.2), e['t'], 0.08, pan=-0.3 + 0.08 * e['k'], dl=0.3)
for e in ev('arrow'):
    send(ui, tick(3600, 0.7, 300), e['t'], 0.07, pan=0.2)
for e in ev('math'):
    ts = tones(e['t'], 1)
    send(lead, bell(ts[(e['k'] - 4) % len(ts)] + 12, 0.8, 0.7), e['t'], 0.07, pan=-0.4 + 0.2 * (e['k'] - 4), rv=0.4)
send(fx, whoosh(0.5, 4000, 400, 0.3), at('pull'), 0.2)
send(lead, pluck(78, 1.0, 1.1), at('blocksHead'), 0.12, rv=0.4, dl=0.35)
V0 = at('diveRow')
send(fx, rev_crash(K['start'] - V0, 1.0), V0, 0.4)
send(fx, whoosh(K['start'] - V0, 250, 8000, 0.9), V0, 0.3)

# ---------------------------------------------------------------- tasks: typing is the rhythm section
send(fx, boom(0.6, 38), K['start'], 0.45, rv=0.3)
send(ui, tick(1800, 0.8, 240), at('select'), 0.14)
for e in ev('key'):
    heavy = e.get('space', False)
    send(ui, keyclick(0.8 + 0.25 * rng.random(), heavy), e['t'] + rng.uniform(-0.004, 0.004), 0.3 if not heavy else 0.34, pan=rng.uniform(-0.15, 0.25))
for e in ev('ghost'):
    ts = tones(e['t'], 1)
    send(ui, pop(1.0, 520, 1500), e['t'], 0.18, pan=0.3)
    send(lead, bell(ts[[1, 2, 4][e['k']]], 1.2, 0.8), e['t'], 0.13, pan=0.3, rv=0.45, dl=0.3)
EN0 = at('enter')
send(ui, keyclick(1.2, True), EN0, 0.5)
send(bassb, bass(CH['G'][0], 0.45, 0.95), EN0, 0.36)
send(fx, boom(0.8, 34), EN0, 0.55, rv=0.3)
send(fx, crash(0.6, 2.5), EN0, 0.3, rv=0.3)
send(keys, stab(CH['G'][1], 0.4, 1.0, 3200), EN0, 0.2, rv=0.35)
send(ui, sparkle(83, 0.9, 4), at('merge'), 0.1, pan=-0.2)
I0, IM = at('iris'), at('open')
send(fx, riser(M['start'] - I0, 300, 11000, 62, 74, 1.0), I0, 0.24)
send(fx, whoosh(IM - I0 + 0.05, 300, 5000, 0.95), I0, 0.3, pan=-0.4)
send(fx, boom(0.5, 44), IM, 0.3, rv=0.3)

# ---------------------------------------------------------------- themes: the chords step with the palettes
send(fx, boom(1.0, 31), M['start'], 0.8, rv=0.25)
send(fx, crash(0.9, 3.0), M['start'], 0.45, rv=0.3)
send(keys, stab(CH['D'][1], 0.5, 1.0, 3200), M['start'], 0.2, rv=0.35)
for e in ev('theme'):
    k = e['k']
    ts = tones(e['t'], 1)
    light = e['mode'] == 'light'
    m = ts[k % len(ts)] + (12 if light else 0)
    send(lead, pluck(m, 0.45, 1.3 if light else 1.0, 1.0), e['t'], 0.13 if light else 0.15, pan=-0.5 + (k % 5) * 0.25, rv=0.35, dl=0.3)
    if not light:
        send(keys, stab([n for n in chord_at(e['t'])[1][1:]], 0.18, 0.7, 2400), e['t'], 0.08, rv=0.25)
    send(ui, tick(2800 + 90 * k, 0.6, 300), e['t'], 0.05, pan=0.3)
LS = at('lightSwitch')
send(fx, whoosh(0.5, 800, 9000, 0.6), LS - 0.3, 0.26)
send(ui, sparkle(90, 1.0, 6), LS, 0.1, pan=0.2)
send(lead, bell(86, 1.8, 0.8), at('settle'), 0.14, rv=0.5, dl=0.3)
send(fx, riser(MO['start'] - at('themesOut'), 400, 10000, 66, 78, 1.0), at('themesOut'), 0.2)

# ---------------------------------------------------------------- montage and collapse
send(fx, boom(1.0, 31), MO['start'], 0.8, rv=0.25)
send(fx, crash(1.0, 3.5), MO['start'], 0.5, rv=0.35)
send(keys, stab(CH['Bm'][1], 0.5, 1.0, 3400), MO['start'], 0.2, rv=0.35)
for e in ev('rowIn'):
    send(fx, whoosh(0.45, 500, 7000, 0.7), e['t'] - 0.2, 0.1, pan=[-0.7, 0.7][e['k'] % 2])
send(fx, riser(2.4, 200, 9000, 64, 76, 1.0), COLLAPSE - 2.4, 0.2)
send(fx, rev_crash(MARK - 0.125 - COLLAPSE, 1.0), COLLAPSE, 0.55)
send(fx, whoosh(MARK - 0.125 - COLLAPSE, 7000, 250, 0.2), COLLAPSE, 0.3)
send(ui, pop(1.0, 400, 1200), at('dotIn'), 0.16)

# ---------------------------------------------------------------- end card: the mark, the motif, the rest
send(fx, boom(1.0, 30), MARK, 0.9, rv=0.3)
send(fx, crash(0.9, 4.5), MARK, 0.5, rv=0.4)
send(padb, pad([50, 57, 62, 64, 66, 69, 73], DUR - MARK - 0.6, a=0.03, r=1.8, cutoff=2600), MARK, 0.55, rv=0.45)
send(bassb, bass(38, 3.2, 0.9), MARK, 0.36)
for m, g in zip([62, 69, 73, 76, 78], [1, 0.8, 0.7, 0.6, 0.55]):
    send(keys, epiano(m, 2.2, 0.95), MARK, 0.17 * g, rv=0.4)
motif = [74, 81, 78]  # D5 A5 F#5: mem - ry - note
for e in ev('syllable'):
    send(lead, bell(motif[e['k']], 2.8, 1.0), e['t'], 0.34, pan=[-0.15, 0.15, 0][e['k']], rv=0.55, dl=0.35)
    send(keys, epiano(motif[e['k']] - 12, 1.2, 0.7), e['t'], 0.1, rv=0.4)
for k, m in enumerate([66, 69, 74, 78]):
    send(lead, pluck(m, 1.2, 1.0), at('tagline') + k * 0.09, 0.1, pan=-0.3 + k * 0.2, rv=0.45, dl=0.4)
send(lead, bell(93, 1.8, 0.6), at('url'), 0.12, pan=0.2, rv=0.6, dl=0.35)
for k in range(6):
    send(ui, tick(3000 + 200 * k, 0.5, 300), at('meta') + k * 0.04, 0.04, pan=-0.3 + 0.12 * k)
# a slow bell line keeps the card alive, then the last note rings out
for k, m in enumerate([69, 73, 74, 78, 76, 74]):
    send(lead, bell(m + 12, 1.6, 0.5), MARK + 2.5 + k * BEAT, 0.06, pan=0.4 * np.sin(k), rv=0.6, dl=0.3)
send(keys, epiano(62, 1.4, 0.7), MARK + 4.5, 0.1, rv=0.5)
send(lead, bell(86, 2.6, 0.7), E['fade'][1] - 1.9, 0.12, rv=0.7, dl=0.3)


# ---------------------------------------------------------------- processing
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


def automate(x, keys_):
    """STFT low-pass whose cutoff follows [(t, fc), ...] log-linearly."""
    f, times, Z = signal.stft(x, fs=SR, nperseg=2048, noverlap=1536, axis=-1)
    kt = np.array([k[0] for k in keys_])
    kf = np.log(np.array([k[1] for k in keys_]))
    fc = np.exp(np.interp(times, kt, kf))
    H = 1 / np.sqrt(1 + (f[:, None] / fc[None, :]) ** 6)
    _, y = signal.istft(Z * H[None], fs=SR, nperseg=2048, noverlap=1536)
    out = np.zeros_like(x)
    m = min(out.shape[1], y.shape[1])
    out[:, :m] = y[:, :m]
    return out


OPEN_ = 20000
MUSIC_FC = [
    (0.0, 500), (1.9, 1500), (2.0, 5200), (3.4, 6000), (3.95, 12000), (4.0, OPEN_),
    # the band dips under each window swap and opens on the downbeat
    (R['out'][0], OPEN_), (R['out'][0] + 0.3, 1600), (V['start'] - 0.02, 2200), (V['start'], OPEN_),
    (V['out'][0], OPEN_), (V['out'][0] + 0.3, 1600), (A['start'] - 0.02, 2200), (A['start'], OPEN_),
    (X0, OPEN_), (X0 + 0.4, 1200), (L['start'] - 0.02, 1500), (L['start'], OPEN_),
    (V0, OPEN_), (V0 + 0.4, 900), (K['start'], 1300), (EN0 - 0.3, 1800), (EN0, OPEN_),
    (COLLAPSE, OPEN_), (MARK - 0.15, 220), (MARK - 0.01, 220), (MARK, OPEN_), (DUR + 4, OPEN_),
]


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


def silence(x, a, b, fade=0.004):
    """Hard gap with tiny fades, for the breath before the logo."""
    i0, i1, f = int(a * SR), int(b * SR), int(fade * SR)
    g = np.ones(x.shape[1])
    g[i0:i1] = 0
    g[max(0, i0 - f):i0] = np.linspace(1, 0, min(f, i0))
    g[i1:i1 + f] = np.linspace(0, 1, f)
    return x * g[None]


dk = duck_env(kicks)
wet = reverb(verb.x, make_ir()) * 0.44
echo = pingpong(dly.x) * 1.8
# bus balance, matched against the explainer's spectral balance (mids were 3-5 dB light)
music = hp(keys.x, 140) * 1.6 + lead.x * 1.1 + (padb.x * 0.42 + bassb.x * 0.5 + arpb.x * 2.6) * dk[None]
music = automate(music + wet * 0.8 + echo * 0.7, MUSIC_FC)
drums = automate(drm.x, [(0, OPEN_), (V0, OPEN_), (V0 + 0.3, 700), (K['start'], 2400), (EN0, OPEN_), (DUR + 4, OPEN_)])
bed = music + drums + fx.x * 0.95 + ui.x + wet * 0.2 + echo * 0.3
bed = silence(bed, GAP, MARK)

# master: bus compression, soft clip, fade the tail into the last frame
m = bed[:, :N]
m[:, :int(0.01 * SR)] *= np.linspace(0, 1, int(0.01 * SR))[None]
m = hp(m - m.mean(axis=1, keepdims=True), 28)
k_ = np.exp(-1 / (0.08 * SR))
lvl = np.sqrt(signal.lfilter([1 - k_], [1, -k_], (m ** 2).mean(0)) + 1e-12)
thr = 10 ** (-12 / 20)
comp = np.where(lvl > thr, (lvl / thr) ** (1 / 1.6 - 1), 1.0)
m = np.tanh(m * comp[None] / 0.9 * 1.05) * 0.9
fade = np.clip((DUR - tt(N)) / 0.9, 0, 1) ** 1.2
m *= fade[None]
tp = np.abs(signal.resample_poly(m, 4, 1, axis=1)).max()  # true-peak estimate
mix = m * (0.89 / tp)


def stat(name, x):
    x = x[:, :N]
    e = np.sqrt(np.maximum(lp(x.mean(0) ** 2, 5), 0))  # the smoothed power rings slightly negative
    act = e > 10 ** (-50 / 20)
    r = np.sqrt((x[:, act] ** 2).mean()) if act.any() else 0
    print(f'{name:7s} active-rms {20 * np.log10(r + 1e-12):6.1f} dB  peak {20 * np.log10(np.abs(x).max() + 1e-12):6.1f} dB  active {act.mean() * DUR:5.1f}s')


for name, b_ in [('keys', keys.x * 1.6), ('lead', lead.x * 1.1), ('pad', padb.x * 0.42), ('bass', bassb.x * 0.5), ('arp', arpb.x * 2.6), ('drums', drm.x),
                 ('fx', fx.x), ('ui', ui.x), ('reverb', wet), ('delay', echo)]:
    stat(name, b_)
print(f'kicks {len(kicks)}, true peak before trim {20 * np.log10(tp):+.2f} dBFS')

out = next((a for a in sys.argv[1:] if not a.startswith('--')), 'score.wav')
with wave.open(out, 'wb') as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes((np.clip(mix, -1, 1).T * 32767).astype('<i2').tobytes())
print('wrote', out)
