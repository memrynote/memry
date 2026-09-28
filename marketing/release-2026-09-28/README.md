# memrynote: release 2026.09.28 film

`memrynote-release-2026-09-28.mp4`: 50 s, 1920x1080, 60 fps, H.264 + AAC 320k, -14 LUFS, music only. A launch film for the 2026.09.28 desktop release. The source is the draft GitHub release `vnext`, with its notes in `release-notes/2026.928.1.md`.

## Idea

The big number comes first, then the proof. "33" rolls in on two reels, and the digits are windows onto the release: the screenshots flash-cut inside them. The camera dives through the first 3 into the product and lands on the change everyone sees first: the sidebar's page list folds into the new rail. A screen recording shows how vaults switch. Six more features follow, about two bars each, each rebuilt from a real screenshot so the UI moves. The smaller changes pass as a wall of type. The wall collapses into the orange dot, and the dot becomes the mark.

Everything on screen comes from the app. It is one of the screenshots in `shots/`, the vault recording, or a rebuild made with the app's own tokens and code:

- the theme palettes from `packages/contracts/src/color-themes.ts`;
- the rail's page glyphs from `lib/icons/page-icons.tsx`;
- the old sidebar rows from `sidebar-nav.tsx` as it was before the rail (`85f1762d7^`);
- the agent diff colors, the task property chips and the priority icon.

## Script (on screen)

| Time | Picture                                                                                                                                                          | Text                                                                                                                   |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 0.0  | the orange dot; the label decodes out of mono noise                                                                                                              | memrynote · release 2026.09.28                                                                                         |
| 0.9  | two reels spin and lock on 33 at 2.0; screenshots flash-cut inside the digits                                                                                    | 33 _new_ features / + 12 improvements · 20 fixes                                                                       |
| 3.45 | the camera dives through the first 3                                                                                                                             |                                                                                                                        |
| 4    | the old sidebar, close: a Navigation list above the tree                                                                                                         | 01 — NAVIGATION · A new way _around_.                                                                                  |
| 4.5  | the labels fold into their icons, the rail slides in from the window edge, the icons fly into it, the tree takes the room back, the white tile lands on Inbox    |                                                                                                                        |
| 6    | the cursor clicks Tasks, Journal, Calendar and Graph with their tooltips; each page rises in                                                                     | Pages live on the rail now. One click, or ⌘1 to ⌘6.                                                                    |
| 8    | ⌘ held: the icons turn into their numbers; ⌘2 jumps back to Inbox                                                                                                |                                                                                                                        |
| 10   | the vault recording: the sidebar lifts off the window and swipes memrynote → Garden → Vocab; a close-up clicks Garden, then memrynote; each vault tints the room | 02 — VAULTS · Hop between _vaults_. · Click one at the foot of the sidebar, or swipe. · ❤️ 🧑‍🌾 📘                       |
| 14   | the agent's diff, rebuilt: 180g → 164g, 7 → 6.5, three new lines; the review bar; the cursor clicks Accept                                                       | 03 — AGENT · Your agent _asks_ first. · Every edit lands as a diff in your note. Nothing is saved until you accept.    |
| 20   | the today line drops, the Gantt chart opens out of it, the rows build                                                                                            | 04 — TIMELINE · Plan on a _timeline_. · Tasks, projects and events, laid out as a Gantt chart.                         |
| 24   | four providers land on dotted eighths                                                                                                                            | 05 — CALENDARS · _Every_ calendar. · Google Calendar, ICS & webcal, CalDAV, macOS Calendar                             |
| 26   | whip-pans across a whiteboard, a Mermaid diagram and math; the note pulls back                                                                                   | 06 — BLOCKS · Whiteboards. Diagrams. Math. · Right in your _notes_. · Whiteboard, Mermaid and math blocks.             |
| 30   | a task row types `Book flights #travel @friday !high`; ghost chips preview; Enter makes them properties                                                          | 07 — TASKS · Type it. It's a _task_. · Quick-add #tags, @dates and !priority as you type. Every property edits inline. |
| 33.5 | an orange iris opens out of the new priority icon                                                                                                                |                                                                                                                        |
| 34   | the Appearance screenshot repainted through all 15 themes: 8 dark on eighths, 7 light on sixteenths                                                              | 08 — THEMES · Make it _yours_. · 15 color themes, in light and dark.                                                   |
| 38   | a tilted paper wall of 42 smaller changes                                                                                                                        | Also new in 2026.09.28                                                                                                 |
| 42.9 | the wall collapses into the dot                                                                                                                                  |                                                                                                                        |
| 44   | the dot becomes the mark; the wordmark lands syllable by syllable                                                                                                | memrynote · Available _now_. · memrynote.com · RELEASE 2026.09.28 · 33 NEW FEATURES · 12 IMPROVEMENTS · 20 FIXES       |
| 49.1 | everything folds back into the dot                                                                                                                               |                                                                                                                        |

## The vault recording

`shots/vaults.mp4` (1286x914, 60 fps, 6.6 s) plays frame by frame inside a window card. `vaults.map` in `timeline.js` pairs film time with recording time, and a monotone cubic runs through the pairs. The recording speeds up through the still stretches (up to about 4.5x) and eases to real speed or slower around each switch, so every switch lands on a beat:

| Film  | Recording | What happens                                    |
| ----- | --------- | ----------------------------------------------- |
| 11.0  | 1.53      | swipe: memrynote → Garden                       |
| 11.5  | 2.88      | swipe: Garden → Vocab                           |
| 11.62 | 3.30–3.95 | the recorder's own zoom into the sidebar's foot |
| 12.24 | 4.27      | click: Garden (switch at 12.5)                  |
| 13.0  | 5.46      | click: memrynote, then the recorder zooms out   |

On top of it, the film adds:

- a 30 px mask, which hides the desktop the recording shows at its window corners;
- the sidebar panel lifting off the window for the two swipes;
- orange rings on the two clicks;
- the big switcher on the left, synced to the switches.

`render.mjs` extracts the frames into `frames/vault/` on first run. The folder is gitignored and `build.sh` clears it, so an edited recording is never stale.

## Music

The score is original and synthesized in `score.py` (numpy/scipy), so there is nothing to license. It runs at 120 BPM in D major and uses the instruments from `../explainer-30s`.

- **Motif:** D5 A5 F#5, the explainer's "mem-ry-note" bells, played on the three wordmark syllables.
- **Arc:**
  - Ticks on the decode and ratchet clicks on the reels lead into a lock hit on "33".
  - A reverse swell runs through the dive, and the drop lands on the rail.
  - The six rail icons land as a rising arpeggio. Clicks, the ⌘ numbers and ⌘2 play on the chord (Bm9, Gmaj9, Dmaj9).
  - The vaults ride Em9 then A6/9, a ii–V into the agent. Each switch is a stab plus a bell pitched per vault (D, F#, A).
  - From the agent on, a house groove carries the features, one chord per bar (Bm9, Gmaj9, Dmaj9, A6/9), so Accept lands on D.
  - Typing thins the band to kick, shaker and key clicks. Enter brings it back.
  - The theme steps play the chord on the grid.
  - The montage peaks with a snare roll, and everything is inhaled into the dot. After a sixteenth of silence, the logo resolves on Dmaj9.
- **Sync:** `render.mjs --events` exports every cue from the picture into `events.json`, 286 in all: keystrokes, rows, rail clicks, vault switches, theme steps and pops. The vault cues are found by inverting the recording's time map. `score.py` places a sound on each cue, pitched to the chord underneath.
- **Levels:** the master peaks at -1 dBTP. `build.sh` measures integrated loudness and applies static gain to reach -14 LUFS, with no limiter.

## Editing

- **Counts and version:** set by `counts` and `version` in `timeline.js`. The reels, the subline and the end card all read them.
  - The counts come from the draft notes, with iOS-only items excluded. The rail is not in those notes yet, so update the counts if the notes change before publishing.
  - The reels expect a two-digit feature count.
- **Smaller changes:** the wall reads them from `MORE_ROWS` in `index.html`.
- **Timing:** every cue lives in `timeline.js`, and sections start on bar lines. After moving cues, run `./build.sh` so `events.json` and the score follow the picture.
- **Vault timing:** a new pair in `vaults.map` moves a moment of the recording onto a new film time. `switches` and `clicks` must stay on pairs.
- **Format:** `score.py` and `render.mjs` split `timeline.js` at the first `=`. The object after `window.TL =` must stay strict JSON, and the header comments must not contain `=`. Keep the `// prettier-ignore` line above it: the pre-commit hook runs prettier, which would strip the quotes from the keys. `build.sh` runs prettier on the files it generates (`themes.js`, `brand.js`, `events.json`), so a rebuild leaves no diff.

## Rebuild

Needs Node with Playwright's Chromium (from the repo root `node_modules`), `uv` and `ffmpeg`.

```bash
./build.sh                                   # palettes + brand -> events -> score -> motion-blurred picture -> mux, about 11 min on an M5 Pro
./build.sh --audio                           # keep the rendered picture, rebuild and remux only the audio
node render.mjs --stills 4.8,10.6            # PNG stills in /tmp/memry-release/stills
node render.mjs --out /tmp/draft.mp4 --sub 1 # draft without motion blur, about a minute
python3 -m http.server 4173                  # live preview at localhost:4173, ?t=12.3 freezes a frame
```

Preview over HTTP, not `file://`. The themes section reads screenshot pixels, and a `file://` page taints the canvas. The live preview needs `frames/vault/`, so run `render.mjs` once first.

| File                      | Role                                                                                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `timeline.js`             | cue sheet shared by picture and score                                                                                                                                                       |
| `index.html`              | the film: deterministic `render(t)` (it returns a promise while a recording frame loads), camera, rebuilt UI, HUD, grain                                                                    |
| `shots/`                  | the release screenshots and the vault recording (below)                                                                                                                                     |
| `frames/`                 | recording frames, extracted by `render.mjs`, gitignored                                                                                                                                     |
| `themes.js`, `themes.mjs` | the 15 theme palettes, generated from `packages/contracts/src/color-themes.ts`                                                                                                              |
| `brand.js`, `brand.mjs`   | mark and wordmark geometry, generated from `assets/brand/memrynote/logo.svg`                                                                                                                |
| `render.mjs`              | local HTTP server, frame extraction, parallel Playwright capture, per-frame motion blur (6 samples, 16 on fast moves and through the recording), ffmpeg encode; `--events` exports the cues |
| `events.json`             | the exported cues                                                                                                                                                                           |
| `score.py`                | score and sound design, reads `timeline.js` and `events.json`                                                                                                                               |
| `build.sh`                | the whole pipeline                                                                                                                                                                          |
| `fonts/`                  | DM Sans and JetBrains Mono (OFL, from fontsource)                                                                                                                                           |

## Screenshots

Taken from the desktop app for this release. All but the timeline are unedited copies.

| Shot                | Original                   | Theme            | Notes                                                        |
| ------------------- | -------------------------- | ---------------- | ------------------------------------------------------------ |
| `rail-inbox.png`    | `inbox.png`                | memrynote light  | the rail order: Home, Inbox, Tasks, Journal, Calendar, Graph |
| `rail-tasks.png`    | `task.png`                 | memrynote light  |                                                              |
| `rail-journal.png`  | `journal.png`              | memrynote light  |                                                              |
| `rail-calendar.png` | `calendar.png`             | memrynote light  |                                                              |
| `rail-graph.png`    | `graph.png`                | memrynote light  |                                                              |
| `vaults.mp4`        | `export-1790622381152.mp4` | memrynote light  | screen recording, three vaults                               |
| `agent.png`         | `ai-diff.png`              | memrynote light  |                                                              |
| `timeline.png`      | `gantt.png`                | Gruvbox dark     | cropped to the app window (1876x1074), 18 px rounded corners |
| `calendars.png`     | `calendar-settings.png`    | Tokyo Night dark |                                                              |
| `blocks.png`        | `new blocks.png`           | memrynote light  |                                                              |
| `themes.png`        | `1-siyah.png`              | memrynote dark   |                                                              |
