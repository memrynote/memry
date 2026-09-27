"""Procedural score for the launch film, synced to the cut times in index.html.

Usage: python3 score.py [out.wav]   (needs numpy)
120 BPM grid anchored at the 10.85s cut, so later cuts (24.35, 28.85, 33.85) land on beats.
"""
import sys, wave
import numpy as np

SR, DUR = 48000, 40.0
N = int(SR * DUR)
rng = np.random.default_rng(7)
L = np.zeros(N); Rt = np.zeros(N)
verb_send = np.zeros(N)
BEAT, G0 = 0.5, 10.85


def hz(m): return 440 * 2 ** ((m - 69) / 12)


def add(sig, t, pan=0.0, gain=1.0, verb=0.3):
    i = int(t * SR)
    if i >= N: return
    s = sig[: N - i] * gain
    L[i:i + len(s)] += s * np.sqrt((1 - pan) / 2)
    Rt[i:i + len(s)] += s * np.sqrt((1 + pan) / 2)
    verb_send[i:i + len(s)] += s * verb


def env(n, a, d):
    t = np.arange(n) / SR
    return np.minimum(1, t / max(a, 1e-4)) * np.exp(-t / d)


def tone(f, dur, a=0.005, d=0.4, harm=(1, .5, .25), detune=0.0):
    n = int(dur * SR); t = np.arange(n) / SR
    s = sum(w * np.sin(2 * np.pi * f * (k + 1) * t * (1 + detune * (k % 2))) for k, w in enumerate(harm))
    return s * env(n, a, d)


def pad(notes, dur, a=1.2, r=1.5, bright=4):
    n = int(dur * SR); t = np.arange(n) / SR
    s = np.zeros(n)
    for m in notes:
        for dt in (-0.004, 0, 0.005):
            f = hz(m) * (1 + dt)
            s += sum(np.sin(2 * np.pi * f * k * t + k) / k ** 1.6 for k in range(1, bright + 1))
    e = np.minimum(1, t / a) * np.minimum(1, (dur - t) / r).clip(0)
    return s * e / (len(notes) * 3)


def noise(dur): return rng.standard_normal(int(dur * SR))


def lowpass(x, cutoff):
    # one-pole, cutoff may be array
    c = np.broadcast_to(np.asarray(cutoff, float), x.shape)
    a = np.exp(-2 * np.pi * c / SR)
    y = np.zeros_like(x); z = 0.0
    for i in range(len(x)):
        z = (1 - a[i]) * x[i] + a[i] * z; y[i] = z
    return y


def kick(g=1.0):
    n = int(.45 * SR); t = np.arange(n) / SR
    f = 45 + 110 * np.exp(-t * 28)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 7) * g


def boom(g=1.0):
    n = int(2.5 * SR); t = np.arange(n) / SR
    f = 32 + 90 * np.exp(-t * 10)
    s = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 1.6)
    s += lowpass(noise(2.5), 900) * np.exp(-t * 6) * .8
    return np.tanh(s * 1.5) * g


def hat(d=.05):
    x = noise(d) - lowpass(noise(d), 6000)
    return x * env(len(x), .001, d / 4)


def whoosh(dur=.7, up=True):
    n = int(dur * SR); t = np.arange(n) / SR
    k = t / dur if up else 1 - t / dur
    x = lowpass(noise(dur), 300 + 7000 * k ** 2)
    return x * np.sin(np.pi * t / dur) ** 2 * 1.4


def riser(dur):
    n = int(dur * SR); t = np.arange(n) / SR; k = t / dur
    x = lowpass(noise(dur), 200 + 9000 * k ** 3) * k ** 2
    x += np.sin(2 * np.pi * np.cumsum(200 + 900 * k ** 2) / SR) * k ** 3 * .15
    return x


def click(g=1.0):
    x = noise(.02) * env(int(.02 * SR), .0005, .003)
    return (x + tone(2400, .02, .0005, .006, (1,))) * g


# ---------- 0-4: the noise ----------
cluster = [60, 61, 66, 67, 71, 72]
add(pad(cluster, 3.9, a=.4, r=.1, bright=3) * .35, 0.0, verb=.2)
for i in range(24):                       # notification pings, one per chip
    t = .05 + i * .075 + .1
    add(tone(hz(rng.choice([79, 84, 86, 88, 91])), .3, .002, .12, (1, .3)) * .12, t, pan=rng.uniform(-.8, .8), verb=.4)
t = .2
while t < 3.65:                           # accelerating tick
    add(click(.25), t, pan=.3 * np.sin(t * 9)); t += max(.06, .35 * (1 - t / 3.4))
add(riser(3.5) * .5, .15, verb=.1)
add(whoosh(.35, False) * .8, 3.55)        # everything sucked into the dot
rev = whoosh(.3, True) * .7
add(rev, 3.72)

# ---------- 4-10.85: calm ----------
add(boom(.9), 4.0, verb=.5)
add(pad([50, 57, 62, 66, 69, 76], 7.2, a=1.0, r=.8) * .5, 4.0, verb=.6)   # Dmaj9
for k, m in enumerate([74, 78, 81]):                                       # logo pieces
    add(tone(hz(m), 1.5, .002, .6, (1, .2, .08)) * .22, 4.75 + k * .1, pan=(k - 1) * .5, verb=.7)
for k, m in enumerate([81, 83, 85, 86, 88, 90, 88, 86, 85]):               # wordmark letters
    add(tone(hz(m), .6, .002, .25, (1, .15)) * .08, 6.25 + k * .04, pan=-.6 + k * .15, verb=.8)
for k, m in enumerate([69, 74, 78]):                                       # tagline
    add(tone(hz(m), 1.2, .01, .5, (1, .3, .1)) * .12, 7.1 + k * .2, verb=.7)
add(boom(.35), 9.35, verb=.4)                                              # "Five modules."
add(boom(.35), 9.75, verb=.4)                                              # "One window."
add(riser(1.2) * .6, 9.7)

# ---------- 10.85-40: groove ----------
CH = [(50, [62, 66, 69, 73]), (47, [62, 66, 69, 71]), (43, [62, 66, 67, 71]), (45, [61, 64, 69, 73])]  # Dmaj7 Bm7 Gmaj7 A


def chord_at(t): return CH[int((t - G0) // (BEAT * 8)) % 4]


b = 0
while True:
    t = G0 + b * BEAT
    if t >= 36.6: break
    priv = 28.85 <= t < 32.25
    if b % 8 == 0:
        root, ns = chord_at(t)
        add(pad(ns, 4.2, a=.3, r=.6) * (.22 if priv else .32), t, verb=.5)
    if not priv or b % 2 == 0:
        add(kick(.9 if not priv else .6), t, verb=.05)
    root, ns = chord_at(t)
    bass = tone(hz(root - 12 + 12), .45, .005, .25, (1, .35, .1))
    add(np.tanh(bass * 2) * .25, t, verb=0)
    if not priv:
        add(hat(.06) * .22, t + BEAT / 2, pan=.3, verb=.1)
        if b % 2 == 1: add((noise(.18) * env(int(.18 * SR), .001, .05) + tone(190, .18, .001, .06, (1,))) * .2, t, verb=.35)  # snare
    for s in range(4):                    # pluck arpeggio 16ths
        m = ns[(b * 4 + s * 3) % 4] + 12 * (s % 2)
        g = (.07 if priv else .1) * (1 if s == 0 else .7)
        add(tone(hz(m), .3, .002, .09, (1, .4, .2, .1)) * g, t + s * BEAT / 4, pan=.5 * np.sin(b + s), verb=.45)
    b += 1

# transitions
for c in (10.85, 24.35, 28.85, 33.85):
    add(whoosh(.7) * .7, c - .45, verb=.3)
    add(boom(.55), c, verb=.4)
for k in range(5):                        # module changes
    c = G0 + k * 2.7
    if k: add(whoosh(.45, True) * .35, c - .3, pan=.4)
    add(tone(hz(86), .8, .001, .3, (1, .3)) * .1, c + .1, verb=.7)
for k in range(58):                       # graph nodes popping
    add(tone(hz(rng.choice([86, 88, 90, 93, 95])), .2, .001, .05, (1,)) * .035, 24.6 + (k / 58) ** .5 * 1.6, pan=rng.uniform(-.9, .9), verb=.6)

# privacy: typing, scramble, lock
t = 29.3
while t < 30.8:
    add(click(.18), t, pan=.2); t += rng.uniform(.045, .09)
scr = noise(1.0) * (np.sign(np.sin(2 * np.pi * 37 * np.arange(SR) / SR)) * .5 + .5)
add(lowpass(scr, 5000) * np.linspace(.05, .25, SR), 31.0, verb=.2)
add(click(.8) + np.pad(click(.6), (int(.04 * SR), 0))[:len(click())], 32.0)
add(boom(.8), 32.05, verb=.6)
add(tone(hz(74), 2.0, .002, .8, (1, .3, .1)) * .18, 32.05, verb=.8)

# toggles
for t, on in ((34.9, 0), (35.3, 0), (35.95, 1)):
    add(click(.5), t)
    add(tone(hz(81 if on else 74), .15, .001, .05, (1,)) * .15, t + .01, verb=.3)

# ---------- end card ----------
add(whoosh(.6) * .6, 36.1)
add(boom(1.0), 36.6, verb=.7)
add(pad([38, 50, 57, 62, 66, 69, 76, 81], 3.4, a=.15, r=2.0, bright=5) * .55, 36.6, verb=.8)
for k, m in enumerate([74, 78, 81, 86]):
    add(tone(hz(m), 2.5, .002, 1.0, (1, .25, .1)) * .16, 36.7 + k * .12, pan=(k - 1.5) * .3, verb=.8)
add(tone(hz(93), 1.2, .001, .5, (1, .2)) * .08, 38.9, verb=.9)                # CTA shine sparkle

# ---------- mix ----------
ir_n = int(2.6 * SR); tt = np.arange(ir_n) / SR
irL = rng.standard_normal(ir_n) * np.exp(-tt * 2.4); irR = rng.standard_normal(ir_n) * np.exp(-tt * 2.4)
F = 1 << int(np.ceil(np.log2(N + ir_n)))
V = np.fft.rfft(verb_send, F)
L += np.fft.irfft(V * np.fft.rfft(irL, F), F)[:N] * .045
Rt += np.fft.irfft(V * np.fft.rfft(irR, F), F)[:N] * .045

mix = np.stack([L, Rt], 1)
mix -= lowpass(mix.mean(1), 25)[:, None]  # DC / sub rumble
fade = np.minimum(1, (DUR - np.arange(N) / SR) / 1.2).clip(0)[:, None]
mix = np.tanh(mix * 1.6) * fade
mix *= 0.89 / np.abs(mix).max()
out = sys.argv[1] if len(sys.argv) > 1 else 'score.wav'
with wave.open(out, 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes((mix * 32767).astype('<i2').tobytes())
print('wrote', out)
