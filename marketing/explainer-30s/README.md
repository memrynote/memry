# memrynote: 30s explainer

Two cuts of the same picture: 1920x1080, 60 fps, H.264 + AAC 320k, -14 LUFS. Both loop seamlessly: the last frame is the first frame.

- `memrynote-explainer-30s.mp4`: music only.
- `memrynote-explainer-30s-voiceover.mp4`: a gentle female narrator over the same music.

## Idea

One thought, followed by an orange thread. The thread carries a single idea ("Lisbon?") from a note to tasks, the calendar, the journal and the agent, then seals it. When the camera finally pulls back, the path the thread drew all along turns out to be the memrynote mark. It fills in, the wordmark lands, and the whole thing folds back into the first dot.

## Script (on screen)

| Time | Picture                                                                    | Text                                                           |
| ---- | -------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 0.0  | a single orange dot, the full stop of the sentence                         | You had a thought.                                             |
| 1.5  | camera whips between other apps                                            | A note here. / A task there. / An event somewhere else.        |
| 3.75 | notifications pile up, the thread knots                                    | Where did it go?                                               |
| 5.5  | freeze, silence, a tug                                                     |                                                                |
| 6.0  | everything is pulled into the dot                                          | memrynote. It all stays in _one place._                        |
| 10   | note card on the thread                                                    | 01 · NOTES — _Write_ it down.                                  |
| 12   | tasks check off on the beat                                                | 02 · TASKS — _Break_ it down.                                  |
| 14   | the flight drops into the week                                             | 03 · CALENDAR — _Pin_ it down.                                 |
| 16   | the journal page for that day                                              | 04 · JOURNAL — _Live_ it.                                      |
| 18   | the agent answers from the journal                                         | 05 · AI AGENT — _Relive_ it.                                   |
| 20   | the room goes dark, every card turns to ciphertext, the dot becomes a lock | END-TO-END ENCRYPTED · OFFLINE-FIRST — Only _you_ can read it. |
| 24   | the thread closes: it drew the mark                                        |                                                                |
| 25.5 | lockup, the three-note motif sings mem-ry-note                             | Your thoughts, _beautifully_ organized. memrynote.com          |
| 29   | the logo shrinks back into the dot                                         |                                                                |

Story details stay consistent for people who rewatch. The sticky note, the chat and the to-do app in the noise all ask about Lisbon. The Friday flight matches the tasks. The Saturday journal line is the one the agent quotes.

## Narration

The voiceover cut speaks the story. On-screen text stays the same, so the narrator says what the viewer reads, timed to the moment it appears. The voice stays silent through the noise (1.5–4.4 s), where the captions and the sound carry it.

| Time                       | Line                                                      |
| -------------------------- | --------------------------------------------------------- |
| 0.30                       | You had a thought.                                        |
| 4.44                       | Where did it go?                                          |
| 6.25                       | memrynote. (after the drop hits)                          |
| 7.25                       | It all stays in one place.                                |
| 10.15, 12.15, 14.15, 16.15 | Write it down. / Break it down. / Pin it down. / Live it. |
| 18.12                      | And relive it.                                            |
| 20.12                      | Encrypted, end to end.                                    |
| 22.08                      | Only you can read it. (after the lock snaps)              |
| 25.55                      | memrynote.                                                |
| 26.55                      | Your thoughts, beautifully organized.                     |

**Voice.** The voice is AI-generated with VoxCPM2 (OpenBMB, Apache-2.0, free for commercial use, 48 kHz), run locally through mlx-audio. It was designed from the description _"A gentle, soothing female narrator, warm and slightly breathy, unhurried and reassuring"_ (design 2, seed 1000). Nine candidates were cast. One was rejected for 15% creaky voice. This one won on naturalness (UTMOS 4.47), a warm pitch (~195 Hz) and no creak. `vo/voice.wav` is that voice. Every line is cloned from it, continuing its reference passage, so all lines are one performance. The model card asks for AI-generated content to be labeled, so label it where a platform asks.

**Takes.** Eight takes per line. Whisper must hear the exact words (the brand is spelled "Memry note" for the model; it reads as "MEM-ree-note"). UTMOS ranks naturalness, pitch has to stay within about 2 semitones of the voice, and the take must fit its window on the picture. The kept takes are in `vo/`, and `vo/takes.json` holds their scores.

**Mix.** Each line is loudness-matched, then goes through EQ, a de-esser, a compressor, a peak limiter and a small room. The music ducks bus by bus, 50 ms before each first syllable, and comes back over 350 ms. The brand-name lines duck harder because the motif bells sit in the voice's range. The line before the tape-stop releases fast so the stop still lands. Outside the narration, the bed is sample-identical to the music-only cut. The voice sits 6–16 LU over the ducked bed. `narrate.py check` has Whisper transcribe every line from the finished mix, full band and band-limited to a phone speaker. All 13 lines are heard.

## Music

The score is original and synthesized in `score.py` (numpy/scipy), so there are no licensing issues. It runs at 120 BPM in D major.

- **Motif:** D5 A5 F#5, sung on "mem-ry-note" at the reveal and at the lockup. The first D5 is the opening "thought" note.
- **Arc:** a ticking, notification-heavy build; a tape-stop into silence on the freeze; a drop on the reveal; then a warm groove through the features (G, A, F#m, Bm, G).
- **Privacy:** the music goes muffled behind a vault filter, a snare roll builds, and it resolves to D when the mark closes.
- **Sync:** every UI sound (checks, drops, ink, glitches, the lock) is pitched to the current chord and lands on a cue in `timeline.js`.

## Rebuild

Needs Node with Playwright's Chromium (repo root `node_modules`), `uv`, and `ffmpeg`.

```bash
./build.sh                       # events -> both scores -> motion-blurred picture -> both cuts, about 7 min on an M5 Pro
./build.sh --audio               # keep the rendered picture, rebuild and remux only the audio
node render.mjs --stills 6,24.5  # PNG stills in /tmp/memry-film/stills
open index.html                  # live preview; index.html?t=12.3 freezes a frame
```

Re-recording the narration needs Apple Silicon. Models download on first run (VoxCPM2 bf16 5 GB, Whisper 1.6 GB):

```bash
RUN="uv run --python 3.12 --with mlx-audio[tts]==0.5.6 --with torch --with torchaudio --with librosa python"
$RUN narrate.py cast               # voice-design candidates, scored
$RUN narrate.py cast --pick 3      # keep one as vo/voice.wav
$RUN narrate.py lines [--only id]  # record lines of narration.json into vo/
$RUN narrate.py check mix.wav      # Whisper listens to a finished mix
```

| File                    | Role                                                                                                                             |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `timeline.js`           | cue sheet shared by picture and score                                                                                            |
| `index.html`            | the film: deterministic `render(t)`, world camera, thread, cards, HUD                                                            |
| `brand.js`, `brand.mjs` | mark outline, bar and wordmark glyphs, generated from `assets/brand/memrynote/logo.svg`                                          |
| `render.mjs`            | parallel Playwright capture, per-frame motion blur (6 samples, 16 on fast frames), ffmpeg encode                                 |
| `score.py`              | score and sound design, reads `timeline.js` + `events.json`; `--vo` mixes the narration                                          |
| `narration.json`        | narration lines: text, spelling for the model, cue, maximum length, ducking overrides                                            |
| `narrate.py`            | voice casting, takes, and the hearing check                                                                                      |
| `vo/`                   | the cast voice, the kept takes, their scores                                                                                     |
| `fonts/`                | DM Sans, Space Grotesk, Crimson Pro, JetBrains Mono (OFL, from fontsource), Excalifont (from the desktop app's excalidraw fonts) |
