"""Narration for the memrynote explainer: cast one voice, then record every line in it.

Voice: VoxCPM2 (OpenBMB, Apache-2.0, free for commercial use, 48 kHz) on Apple Silicon through
mlx-audio. Nobody listens to the takes, so each one is measured instead: Whisper must hear the
scripted words, UTMOS predicts naturalness, pitch and pace keep every line inside one
performance, and a take has to fit its window on the picture.

    RUN="uv run --python 3.12 --with mlx-audio[tts]==0.5.6 --with torch --with torchaudio --with librosa python"
    $RUN narrate.py cast               # voice-design candidates, scored -> $TMPDIR/memry-film/cast
    $RUN narrate.py cast --pick 3      # keep candidate 3 as vo/voice.wav
    $RUN narrate.py probe "Memree-note."  # hear-check a spelling through Whisper
    $RUN narrate.py lines              # every line of narration.json -> vo/<id>.wav + vo/takes.json
    $RUN narrate.py check mix.wav      # Whisper listens to the finished mix, full band and phone speaker
"""
import argparse
import json
import os
import re
import shutil

import numpy as np
import soundfile as sf
from scipy import signal

HERE = os.path.dirname(os.path.abspath(__file__))
TMP = os.path.join(os.environ.get('TMPDIR', '/tmp'), 'memry-film')
VO = os.path.join(HERE, 'vo')
SR = 48000
TTS_MODEL = 'mlx-community/VoxCPM2-bf16'
ASR_MODEL = 'mlx-community/whisper-large-v3-turbo-asr-fp16'
NARRATION = json.load(open(os.path.join(HERE, 'narration.json')))
TL = json.loads(open(os.path.join(HERE, 'timeline.js')).read().split('=', 1)[1].strip().rstrip(';'))


def cue(expr):
    """'privacy.lock+0.1' -> seconds, read from timeline.js."""
    m = re.fullmatch(r'([a-zA-Z0-9_.]+)([+-][0-9.]+)?', expr)
    v = TL
    for k in m.group(1).split('.'):
        v = v[int(k)] if isinstance(v, list) else v[k]
    return float(v) + float(m.group(2) or 0)


# ---------------------------------------------------------------- models (loaded once, lazily)
_m = {}


def tts():
    if 'tts' not in _m:
        from mlx_audio.tts.utils import load
        _m['tts'] = load(TTS_MODEL)
    return _m['tts']


def speak(text, seed, instruct=None, ref=None, prompt=None, cfg=2.0, steps=10):
    import mlx.core as mx
    mx.random.seed(seed)
    kw = dict(inference_timesteps=steps, cfg_value=cfg)
    if instruct:
        kw['instruct'] = instruct
    if ref is not None:
        kw['ref_audio'] = ref
    if prompt is not None:
        kw['prompt_audio'], kw['prompt_text'] = prompt
    out = next(tts().generate(text, **kw))
    return np.array(out.audio, dtype=np.float32)


def to16k(x):
    return signal.resample_poly(x, 1, 3).astype(np.float32)


def hear(x, hint='memrynote'):
    if 'asr' not in _m:
        from mlx_audio.stt.utils import load
        _m['asr'] = load(ASR_MODEL)
    r = _m['asr'].generate(to16k(x), language='en', temperature=0.0, initial_prompt=hint,
                           condition_on_previous_text=False)
    return r.text.strip()


def mos(x):
    import torch
    if 'mos' not in _m:
        _m['mos'] = torch.hub.load('tarepan/SpeechMOS:v1.2.0', 'utmos22_strong', trust_repo=True).eval()
    with torch.no_grad():
        return float(_m['mos'](torch.from_numpy(to16k(x))[None], 16000).item())


def pitch(x):
    """Median F0 (Hz) and the 10-90 percentile span in semitones."""
    import librosa
    f0, voiced, _ = librosa.pyin(to16k(x), fmin=70, fmax=520, sr=16000, frame_length=1024, hop_length=160)
    f = f0[voiced & np.isfinite(f0)]
    if len(f) < 8:
        return float('nan'), float('nan')
    return float(np.median(f)), float(12 * np.log2(np.percentile(f, 90) / np.percentile(f, 10)))


# ---------------------------------------------------------------- text + audio helpers
def norm(s):
    s = s.lower().replace('-', ' ')
    s = re.sub(r"\b(mem\w*\s*(ree|ri|ry|ory|ery)?\s*note|memrynote|memorynote)\b", 'memrynote', s)
    s = re.sub(r"[^a-z' ]", ' ', s)
    return s.split()


def wer(ref, hyp):
    r, h = norm(ref), norm(hyp)
    d = np.arange(len(h) + 1)
    for i in range(1, len(r) + 1):
        prev, d[0] = d.copy(), i
        for j in range(1, len(h) + 1):
            d[j] = min(prev[j] + 1, d[j - 1] + 1, prev[j - 1] + (r[i - 1] != h[j - 1]))
    return d[len(h)] / max(1, len(r))


def trim(x, pre=0.03, post=0.14, rel_db=-40.0, abs_db=-55.0):
    """Cut to the speech, keep a short breath of room either side, fade the edges."""
    hop, win = int(0.005 * SR), int(0.02 * SR)
    frames = np.lib.stride_tricks.sliding_window_view(np.pad(x, (win // 2, win // 2)), win)[::hop]
    db = 10 * np.log10((frames ** 2).mean(1) + 1e-12)
    on = np.nonzero(db > max(db.max() + rel_db, abs_db))[0]
    if len(on) == 0:
        return x, 0
    a = max(0, on[0] * hop - int(pre * SR))
    b = min(len(x), on[-1] * hop + win + int(post * SR))
    y = x[a:b].copy()
    fi, fo = int(0.006 * SR), int(0.06 * SR)
    y[:fi] *= np.sin(np.linspace(0, np.pi / 2, fi)) ** 2
    y[-fo:] *= np.cos(np.linspace(0, np.pi / 2, fo)) ** 2
    lead = (on[0] * hop) - a  # samples of room before the first sound
    return y, int(lead)


def speech_seconds(y, lead):
    return (len(y) - lead - int(0.14 * SR)) / SR


def save(path, x):
    sf.write(path, x / max(1e-9, np.abs(x).max()) * 10 ** (-3 / 20), SR, subtype='FLOAT')


# ---------------------------------------------------------------- cast
def cast(args):
    v = NARRATION['voice']
    out = os.path.join(TMP, 'cast')
    os.makedirs(out, exist_ok=True)
    if args.pick is not None:
        os.makedirs(VO, exist_ok=True)
        shutil.copy(os.path.join(out, f'cand-{args.pick:02d}.wav'), os.path.join(VO, 'voice.wav'))
        print('voice ->', os.path.join(VO, 'voice.wav'))
        return
    rows = []
    k = 0
    for d, desc in enumerate(v['designs']):
        for s in range(args.seeds):
            x, lead = trim(speak(v['reference_text'], seed=1000 * d + s, instruct=desc))
            heard = hear(x)
            f0, span = pitch(x)
            words = len(v['reference_text'].split())
            row = dict(k=k, design=d, seed=1000 * d + s, dur=round(len(x) / SR, 2),
                       wps=round(words / speech_seconds(x, lead), 2), f0=round(f0), span=round(span, 1),
                       mos=round(mos(x), 2), wer=round(wer(v['reference_text'], heard), 2), heard=heard)
            save(os.path.join(out, f'cand-{k:02d}.wav'), x)
            rows.append(row)
            print(json.dumps(row), flush=True)
            k += 1

    def score(r):  # natural, female, unhurried, every word intact
        pen = 3 * r['wer'] + 0.8 * max(0, abs(r['wps'] - 2.5) - 0.3) + (2 if not 165 <= r['f0'] <= 280 else 0)
        return r['mos'] - pen

    rows.sort(key=score, reverse=True)
    json.dump(rows, open(os.path.join(out, 'cast.json'), 'w'), indent=1)
    print('\nranked:')
    for r in rows:
        print(f"  cand-{r['k']:02d}  score {score(r):5.2f}  mos {r['mos']:.2f}  wer {r['wer']:.2f}  "
              f"f0 {r['f0']} Hz  span {r['span']} st  {r['wps']} w/s  {r['dur']} s")


# ---------------------------------------------------------------- lines
def reference():
    x, _ = sf.read(os.path.join(VO, 'voice.wav'), dtype='float32')
    return x


def take(line, seed, ref):
    v = NARRATION['voice']
    style = ', '.join(s for s in (v.get('style'), line.get('style')) if s)
    return trim(speak(line.get('say', line['text']), seed=seed, instruct=style or None, ref=ref,
                      prompt=(ref, v['reference_text']) if v.get('continuation') else None))


def lines(args):
    ref = reference()
    f0_voice = pitch(ref)[0]
    report = []
    only = set(args.only.split(',')) if args.only else None
    for n, line in enumerate(NARRATION['lines']):
        if only and line['id'] not in only:
            continue
        budget = line['max']
        best = None
        for s in range(args.takes):
            seed = 7000 + 97 * n + s
            y, lead = take(line, seed, ref)
            heard = hear(y)
            f0, span = pitch(y)
            dur = (len(y) - lead) / SR - 0.1  # speech plus a short tail
            m = mos(y)
            e = wer(line['text'], heard)
            drift = abs(12 * np.log2(f0 / f0_voice)) if np.isfinite(f0) else 6.0
            score = m - 4 * e - 3 * max(0, dur - budget) - 0.12 * max(0, drift - 1.5)
            row = dict(id=line['id'], seed=seed, score=round(score, 3), mos=round(m, 2), wer=round(e, 2),
                       dur=round(dur, 2), budget=budget, f0=round(f0) if np.isfinite(f0) else None,
                       span=round(span, 1) if np.isfinite(span) else None, heard=heard)
            print(json.dumps(row), flush=True)
            if best is None or score > best[0]['score']:
                best = (row, y, lead)
        row, y, lead = best
        path = os.path.join(VO, f"{line['id']}.wav")
        save(path, y)
        row.update(file=os.path.basename(path), lead=round(lead / SR, 4))
        report.append(row)
        print('  kept', json.dumps(row), flush=True)
    path = os.path.join(VO, 'takes.json')
    old = {r['id']: r for r in (json.load(open(path)) if os.path.exists(path) and only else [])}
    old.update({r['id']: r for r in report})
    order = [l['id'] for l in NARRATION['lines']]
    json.dump(sorted(old.values(), key=lambda r: order.index(r['id'])), open(path, 'w'), indent=1)


def check(args):
    """Every line must still be heard over the music, on good speakers and on a phone."""
    takes = {r['id']: r for r in json.load(open(os.path.join(VO, 'takes.json')))}
    x, sr = sf.read(args.mix, dtype='float32')
    x = x.mean(1) if x.ndim > 1 else x
    if sr != SR:
        x = signal.resample_poly(x, SR, sr).astype(np.float32)
    phone = signal.sosfilt(signal.butter(4, [300, 4000], 'band', fs=SR, output='sos'), x).astype(np.float32)
    bad = 0
    for line in NARRATION['lines']:
        on = cue(line['at'])
        a, b = int((on - 0.08) * SR), int((on + takes[line['id']]['dur'] + 0.25) * SR)
        row = []
        for name, sig in (('full', x), ('phone', phone)):
            heard = hear(sig[a:b], hint=None)
            e = wer(line['text'], heard)
            bad += e > 0
            row.append(f'{name} {e:.2f} {heard!r}')
        print(f"{line['id']:8s} {on:6.2f}s  " + '   '.join(row), flush=True)
    print('every line heard, full band and phone' if not bad else f'{bad} hearing(s) not clean')


def probe(args):
    ref = reference()
    for text in args.texts:
        for s in range(args.takes):
            y, _ = take({'text': text}, 500 + s, ref)
            print(f'{text!r:34s} seed {500 + s}: heard {hear(y, hint=None)!r}', flush=True)
            save(os.path.join(TMP, f'probe-{re.sub(r"[^a-z]", "", text.lower())}-{s}.wav'), y)


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)
    c = sub.add_parser('cast')
    c.add_argument('--seeds', type=int, default=3)
    c.add_argument('--pick', type=int)
    l_ = sub.add_parser('lines')
    l_.add_argument('--takes', type=int, default=6)
    l_.add_argument('--only')
    p = sub.add_parser('probe')
    p.add_argument('texts', nargs='+')
    p.add_argument('--takes', type=int, default=2)
    k = sub.add_parser('check')
    k.add_argument('mix')
    a = ap.parse_args()
    {'cast': cast, 'lines': lines, 'probe': probe, 'check': check}[a.cmd](a)
