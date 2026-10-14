# memrynote: release 2026.10.14 film

`memrynote-release-2026-10-14.mp4`: 60 s, 1920x1080, 60 fps, H.264 + AAC 320k, -14 LUFS, music only. A launch film for the 2026.10.14 desktop release. The source is the draft GitHub release `vnext`. No humanized notes existed for the whole draft when the film was made, so the counts are raw PR counts with iOS-only items left out: 49 features and 180 fixes.

## Idea

The number comes first, then the proof. "49" rolls in on two reels with the release flash-cut inside the digits, and the camera dives through the 4 into the first card. Eight features follow: writing tools gets six bars and tags with fields four, the others two each. Every card is a real capture of the desktop app, and each change is a later capture of the same window cut in over exactly the region the app changed. The smaller changes pass as a wall of type that collapses into the orange dot, and the dot becomes the mark.

Nothing on screen is drawn from memory. The captures came from the built desktop app, driven over Playwright CDP, on a copy of the `memry-vaults/Sandbox` vault. What the film adds on top of the app's pixels: the cursor, the click rings, the keycaps beside the headlines, the orange highlight over "Cape Kennedy" on the scanned page, and the shell command under the lock card.

## Script (on screen)

| Time | Picture                                                                                                                                                                                                                                                                                                  | Text                                                                                                                                         |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.0  | the orange dot; the label decodes out of mono noise                                                                                                                                                                                                                                                      | memrynote · release 2026.10.14                                                                                                               |
| 0.9  | two reels lock on 49 at 2.0; captures flash-cut inside the digits                                                                                                                                                                                                                                        | 49 _new_ features / + 180 fixes                                                                                                              |
| 3.45 | the camera dives through the 4; the first card flies out of it                                                                                                                                                                                                                                           |                                                                                                                                              |
| 4    | "deleted" is double-clicked, ⌥⌘A opens its alternatives card, "lost" and "thrown away" are typed, ↓ swaps "lost" in; one sentence is ghosted and another stashed in overflow from the right-click menu; Lab's Check underlines three long sentences, Tighten dims six spans, the trim bar rises, Cut all | 01 — Writing tools · Write it _better_. · Keep other versions instead of deleting, ghost a line, stash the rest, and let Lab check and trim. |
| 16   | ⌘K opens the new palette; "Cape Kennedy" is typed; the only hit is the Apollo 1 memo; Enter; the camera pushes into the scan and the words light up                                                                                                                                                      | 02 — Search · Search what's _inside_. · Scanned PDFs and images now turn up by the words written in them.                                    |
| 20   | an untagged note: "Suggested tags:" and three chips pop in; space-race is clicked; the note's similar notes slide in                                                                                                                                                                                     | 03 — Suggested tags · Tags, _suggested_. · A model on your device reads the note and finds the tags and notes that fit.                      |
| 24   | #person is added; Role, Email and Phone are typed; Company links Harbor Lane Press; the #person page lists all ten people with the fields as columns; Edit tag, Add field, "Met on", Date                                                                                                                | 04 — Tags with fields · Tags that _hold_ data. · A tag brings its own fields to every note that has it, and its page lists them all.         |
| 32   | four subtask levels land on the beat, tab keycap each time; an orange iris opens out of the deepest row                                                                                                                                                                                                  | 05 — Subtasks · As deep as you _need_. · Subtasks inside subtasks, at any depth.                                                             |
| 36   | /view ↵ drops a block with its source menu open; Tag → space-race; list, then table, then gallery                                                                                                                                                                                                        | 06 — View block · A live list, in _place_. · Type /view to embed the notes from a folder, a tag or the vault.                                |
| 40   | sleep's 30-day line draws itself; flip to workout as a 26-week heatmap, filling week by week                                                                                                                                                                                                             | 07 — Charts · Watch it _change_. · Chart any property over time: a line, bars or a heatmap.                                                  |
| 44   | ⋯ → Lock note; the title greys out and "Locked." appears; a shell command appends to the file; the app undoes the edit and says so                                                                                                                                                                       | 08 — Lock · Lock it _down_. · Read-only for you, for your agents and for every outside tool.                                                 |
| 48   | a tilted paper wall of 42 smaller changes                                                                                                                                                                                                                                                                | Also new in 2026.10.14                                                                                                                       |
| 52.9 | the wall collapses into the dot                                                                                                                                                                                                                                                                          |                                                                                                                                              |
| 54   | the dot becomes the mark; the wordmark lands syllable by syllable                                                                                                                                                                                                                                        | memrynote · Available _now_. · memrynote.com · RELEASE 2026.10.14 · 49 NEW FEATURES · 180 FIXES                                              |
| 59.1 | everything folds back into the dot                                                                                                                                                                                                                                                                       |                                                                                                                                              |

## Cards

Each section is one card built by `makeCard` from a base capture. `lay` puts a region of a later capture over the card at a cue time, with a mode: `cut`, `fade`, `wipe`, `down`, `pop`, `up`, `row` or `type`. `full` lays a whole later capture and hides everything laid before it once it lands. A `null` capture is a white patch that hides a region of the base until something replaces it. The regions came from a pixel diff of each capture pair (`probe.py`, in the skill), so a change shows only where the app changed.

`placeCard` fits a focus rect of the capture into the stage box right of the headline, crops the card to it, and carries it in and out with the section's `inMove` and `outMove`. A rect track moves the focus inside a section, for the pushes and the pans.

## Music

The score is original and synthesized in `score.py` (numpy/scipy), with the instruments from `../explainer-30s`. 120 BPM, D major.

- **Motif:** D5 A5 F#5, the "mem-ry-note" bells, on the three wordmark syllables.
- **Arc:**
  - Ticks on the decode and ratchet clicks on the reels lead into a lock hit on "49". A reverse swell runs through the dive, and the drop lands on writing tools.
  - The house loop (Bm9 G D A) carries the eight sections, one chord per bar. Each section lands with a boom and a stab on its bar line, and the band dips under each card swap.
  - Every change in a card plays on the chord underneath: cuts and fades as plucks, pops and rows as pops with a bell, clicks as ticks. The ↓, ⌘K, ↵, tab and /view keycaps are heavy key clicks with a stab.
  - Typing the search query and the shell command thins the band to kick, shaker and keys.
  - The line chart rides a riser into a sparkle; the heatmap climbs the chord one week at a time.
  - A snare roll carries the iris into the view block. The montage peaks with a snare roll, everything is inhaled into the dot, and after a sixteenth of silence the logo resolves on Dmaj9.
- **Sync:** `render.mjs --events` exports every cue from the picture into `events.json`, 388 in all. Layers export by mode, so a new `lay` gets a sound without touching `score.py`.
- **Levels:** the master peaks at -1 dBTP. `build.sh` applies static gain to -14 LUFS, with no limiter.

## Editing

- **Counts and version:** `counts` and `version` in `timeline.js`. The reels expect a two-digit feature count. Update the counts if humanized notes for the release land before publishing.
- **Smaller changes:** the wall reads them from `MORE_ROWS` in `index.html`.
- **Timing:** every cue lives in `timeline.js`, and sections start on bar lines. After moving cues, run `./build.sh` so `events.json` and the score follow the picture.
- **Format:** `score.py` and `render.mjs` split `timeline.js` at the first `=`. The object after `window.TL =` must stay strict JSON, and the header comments must not contain `=`. Keep the `// prettier-ignore` line above it.

## Rebuild

Needs Node with Playwright's Chromium (from the repo root `node_modules`), `uv` and `ffmpeg` on the PATH.

```bash
./build.sh                                   # palettes + brand -> events -> score -> motion-blurred picture -> mux
./build.sh --audio                           # keep the rendered picture, rebuild and remux only the audio
node render.mjs --stills 4.8,10.6            # PNG stills in /tmp/memry-release/stills
node render.mjs --out /tmp/draft.mp4 --sub 1 # draft without motion blur, about a minute and a half
python3 -m http.server 4173                  # live preview at localhost:4173, ?t=12.3 freezes a frame
```

| File                      | Role                                                                                                                                            |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `timeline.js`             | cue sheet shared by picture and score                                                                                                           |
| `index.html`              | the film: deterministic `render(t)`, camera, cards and layers, HUD, grain                                                                       |
| `shots/`                  | the captures (below)                                                                                                                            |
| `themes.js`, `themes.mjs` | theme palettes generated from `packages/contracts/src/color-themes.ts`, kept with the engine, unused by this film's cards                       |
| `brand.js`, `brand.mjs`   | mark and wordmark geometry, generated from `assets/brand/memrynote/logo.svg`                                                                    |
| `render.mjs`              | local HTTP server, parallel Playwright capture, per-frame motion blur (6 samples, 16 on fast moves), ffmpeg encode; `--events` exports the cues |
| `events.json`             | the exported cues                                                                                                                               |
| `score.py`                | score and sound design, reads `timeline.js` and `events.json`                                                                                   |
| `build.sh`                | the whole pipeline                                                                                                                              |
| `fonts/`                  | DM Sans and JetBrains Mono (OFL, from fontsource)                                                                                               |

## Captures

All 61 captures are the desktop app's 1440x900 window at 2x (2880x1800), memrynote light theme, on a copy of the Sandbox vault opened by a `/tmp` copy of `apps/desktop/scripts/agent-app.mjs` (temp profile, no sign-in). Writing tools and tags with fields were captured from main at 52a4ded1d, the rest from 0665b1213. On 52a4ded1d a "Your session has ended" dialog opens at launch in the offline test profile; it was dismissed before capturing.

| Captures                  | Section          | What they show                                                                                                                                                                                                                               |
| ------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wa0`–`wa8`               | Writing tools    | "Why memrynote keeps your drafts" (the repo's writing-tools seed note, `apps/desktop/scripts/seed-data/writing-drafts.ts`) with the Alternatives rail: "deleted" selected, ⌥⌘A, two versions typed, ↓ to "lost"                              |
| `wg0`–`wg3`, `wo0`–`wo3`  | Writing tools    | a sentence ghosted and another stashed in overflow, each through the editor context menu                                                                                                                                                     |
| `wc0`–`wc3`, `wt0`–`wt4`  | Writing tools    | Lab: Check's Run and its three results, Tighten's six dimmed spans and trim bar, Cut all. **The model's answers are fixed:** a local stand-in for the inline AI endpoint returned three findings and six verbatim cuts. The UI is the app's. |
| `s-pre`, `s0`, `s2`, `s3` | Search           | the note before ⌘K, the empty palette, "Cape Kennedy" with its one hit, the Apollo 1 memo note after Enter. The word is in no markdown file; the hit is the scan's OCR text                                                                  |
| `h0`–`h2`                 | Suggested tags   | a new untagged note "Hamilton's listings": suggestions, space-race hovered, after the click                                                                                                                                                  |
| `u0`–`u2`, `f1`–`f5`      | Tags with fields | a new note "Ines Duarte": the person suggestion, #person added, Role, Email and Phone typed, the Company picker, Harbor Lane Press linked                                                                                                    |
| `p3`–`p5`, `q0`–`q3`      | Tags with fields | the #person tag page (ten people, fields as columns), Edit tag hovered, the tag's settings, Add field, a Date field "Met on"                                                                                                                 |
| `k1`                      | Subtasks         | Tasks › Aurora launch, six levels deep; the three deepest were added in the app for the film                                                                                                                                                 |
| `v1`–`v5`                 | View block       | a new note "Space race reading": `/view` with its source menu, Tag submenu, #space-race as list, table, gallery                                                                                                                              |
| `c2`, `c3`                | Charts           | a `/chart` block: sleep over 30 days as a line, workout over 26 weeks as a heatmap                                                                                                                                                           |
| `x0`–`x3`, `y3`           | Lock             | Margaret Hamilton's listings: before, the ⋯ menu, Lock note hovered, locked, the toast after an outside write to the file was undone                                                                                                         |
