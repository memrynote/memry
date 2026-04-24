# S1 Manual Test Checklist

These tests cannot be reliably automated (IME composition events, rich clipboard
from external apps, native window resize, WebGL smoke). Execute manually and
record result in the respective section below.

**App to test:** `spikes/tauri-risk-discovery/app/`
**Run via:** `cd spikes/tauri-risk-discovery/app && pnpm tauri dev`

---

## Test #3 — IME Japanese input

**Setup:**
- macOS System Settings → Keyboard → Input Sources → Add "Hiragana" (Japanese)
- In Tauri app, click into BlockNote editor
- Switch input to Hiragana (Cmd+Space)

**Procedure:**
1. Type `konnichiwa` (should show hiragana composition underline as you type)
2. Press Space to convert to kanji candidates
3. Press Enter to commit `こんにちは`

**Pass criteria:**
- Composition underline visible during typing
- Conversion UI appears on Space
- Final text `こんにちは` appears, no duplicate/dropped characters

**Result:** PASS

**Notes:**
[Any observations — duplicate characters, dropped composition events, IME UI glitches, etc.]

**Evidence:** `screenshots/test-3-ime-before.png`, `test-3-ime-after.png`
(take screenshots via Cmd+Shift+4, save to `benchmarks/screenshots/`)

---

## Test #5 — Paste rich HTML from external source

**Setup:**
- Open https://docs.google.com/ in macOS Safari (outside Tauri app)
- Create a short document with:
  - h1 heading
  - h2 heading
  - bold text
  - italic text
  - unordered list with 3 items
  - ordered list with 3 items
  - 1 link

**Procedure:**
1. Select entire document (Cmd+A), copy (Cmd+C)
2. Switch to Tauri spike app (BlockNote editor)
3. Click into editor
4. Paste (Cmd+V)

**Pass criteria (structural preservation):**
- Headings (h1, h2) render as block-level headings in BlockNote
- Bold/italic marks preserved (look bold/italic visually)
- Lists (ul, ol) preserved, item order correct
- Links' href preserved (hover to verify URL)

**Acceptable losses:**
- Inline style attributes (`style="color:red"` → no color) MAY be lost
- CSS class names MAY be lost

**Fail criteria:**
- Blocks collapsed to single paragraph
- List items merged or reordered
- Text characters dropped

**Result:** PASS

**Notes:**
[What was preserved, what was lost]

**Evidence:** `screenshots/test-5-paste-html-source.png`, `test-5-paste-html-result.png`

---

## Test #14 — Window resize mid-typing

**Procedure:**
1. Open Tauri spike app (`pnpm tauri dev`)
2. Type a few paragraphs into BlockNote editor
3. Position caret in middle of text
4. Drag window corner to resize:
   - Shrink width by ~40%
   - Then enlarge by ~60%
5. Continue typing — observe caret behavior

**Pass criteria:**
- Text reflows with new width
- Caret stays at same logical position (same word/character)
- Continued typing inserts at correct position

**Fail criteria:**
- Caret jumps to unrelated position
- Text layout breaks (overlaps, disappears)
- Typing inserts at wrong location

**Result:** [PASS / FAIL]

**Notes:**
[Any observations about WKWebView reflow behavior]

**Evidence:** `screenshots/test-14-resize-before.png`, `test-14-resize-after.png`

---

## Test #15 — @react-sigma graph smoke (WebGL in WKWebView)

**Setup:**
Create a temporary branch of `App.tsx` that renders a minimal @react-sigma graph.

**Option A — Replace App.tsx temporarily:**

```bash
cd spikes/tauri-risk-discovery/app
pnpm add @react-sigma/core graphology
```

Replace `App.tsx` with minimal sigma test (10 nodes, see evidence below), run
`pnpm tauri dev`.

**Option B — Skip if time-constrained:**

If graph testing in webview is not blocking for Subproject 1, mark this test
as deferred. Memry's graph view is a lower-priority feature; losing it
wouldn't invalidate migration.

**Pass criteria:**
- Graph renders (10 node dots visible)
- WebGL context opens (no "WebGL not supported" error in devtools)
- Pan (drag) responsive, zoom (scroll) smooth (> 30 fps subjective)

**Fail criteria:**
- Crash on mount
- Empty canvas (WebGL context failed)
- Pan/zoom janky (< 20 fps)

**Result:** PASS

**Notes:**
[Any observations about WebGL in WKWebView]

**Post-test cleanup:** If Option A used, revert App.tsx to BlockNote-only.

**Evidence:** `screenshots/test-15-sigma-render.png`
