# Resizable inline PDF embeds

**Date:** 2026-07-16
**Status:** Approved design → implementation
**Scope:** Desktop app, note editor. PDF-in-note embeds only.

## Problem

PDFs embedded in a note render at a hardcoded width (`480px` when the page
sidebar is open, `600px` otherwise) with a fixed `max-h-[400px]` scroll box.
There is no way to make a PDF bigger or smaller. Landscape and portrait PDFs
both get the same fixed width, so neither reads well. Users want to adjust the
display size per embedded PDF.

## Non-goals

- The full-page standalone `PdfViewer` (`components/viewers/pdf-viewer.tsx`)
  already has its own zoom; it is untouched.
- Images are BlockNote's default `image` block with its own native resize
  handle; out of scope.
- Non-PDF file cards (the generic attachment card in the same `file` block)
  keep their current fixed layout.
- Keyboard arrow-nudge resize — deferred (nice-to-have, not in this pass).

## Model

Drag = **width**, aspect-locked. `react-pdf`'s `<Page width={n}>` derives the
rendered height from the PDF page's native aspect ratio, so a single `width`
value handles both orientations correctly:

- Landscape (e.g. 16:9) at width 600 → short and wide.
- Portrait (e.g. A4) at width 600 → tall and narrow.

No independent height (would distort or crop the page). No zoom/scale state.

## Design

### 1. Data & persistence

- Add `width: { default: 0 }` to the `file` block `propSchema` in
  `renderer/src/components/note/content-area/file-block.tsx` and to the
  `FileBlockProps` interface in `file-block-markers.ts`.
- `0` is the sentinel for "no explicit width → use the default". This keeps
  every existing PDF marker (which has no `width` field) rendering exactly as
  before — **backward-compatible, no migration needed**.
- Persistence is free: the block already serializes its whole props object to a
  `<!-- file:{...} -->` HTML-comment marker via `serializeFileBlock`, and parses
  it back via `parseFileBlockMarker` (`file-block-markers.ts`). A numeric
  `width` field round-trips automatically and is safe with the existing
  `FILE_BLOCK_REGEX` (`/<!-- file:(\{[^}]+\}) --/g`) because the value has no
  nested braces.
- Keep the main-side duplicate in `main/import/_shared/attachment-markdown.ts`
  (`serializeFileBlockMarker`, `FileBlockProps` shape) in sync. Importers keep
  omitting `width`, so imported PDFs get the default — no behavior change there.
- The main-side sync/CRDT converter (`main/sync/blocknote-converter.ts`) does
  not handle `file` blocks, so no change is needed there; the vault round-trip
  runs entirely through the renderer serializer.

### 2. Rendering

In `PdfPreview` (`file-block.tsx`):

- Resolve the effective page width: `props.width || (sidebarOpen ? 480 : 600)`.
- Clamp the rendered width to the editor column width via a container ref /
  `ResizeObserver` (or `max-width: 100%` on the wrapper) so a stored width wider
  than the current window never overflows horizontally.
- Relax the `max-h-[400px]` cap on the page scroll container so an enlarged page
  grows vertically instead of scrolling inside a fixed box. (Very tall portrait
  pages still get a sane upper bound / natural page flow — see edge cases.)
- Pass the resolved width to `<Page width={...} />`. Thumbnail sidebar width and
  its `480 vs 600` split are preserved as the _default_ only.

### 3. Interaction — the drag handle

- A bottom-right corner handle overlaid on the PDF page, revealed on hover or
  when the block is selected.
- Pointer-drag adjusts **width** (aspect-locked; height auto-follows).
- Uses **pointer capture** (`setPointerCapture`) and `stopPropagation` /
  `preventDefault` so dragging never starts a text selection, moves the
  BlockNote block, or bubbles into the editor.
- During drag: track width in **local component state** for smooth 60fps
  feedback. **Commit once on pointer-up** by writing the final width to the
  block prop (`editor.updateBlock` / the block's prop-update path) — avoids
  spamming CRDT/IPC on every pointer move.
- Clamp: `min ≈ 240px` → `max = editor column width`. Gentle snap to full
  column width when released within a small threshold of the edge.
- Rendered **only when `isPdf`** (`mimeType === 'application/pdf'`).

### 4. Accessibility & motion

- The handle is focusable, has a visible focus ring and an `aria-label`
  (e.g. "Resize PDF").
- Hover reveal is instant / respects `prefers-reduced-motion` (no motion
  requirement; if any transition is added it is gated by the existing global
  reduced-motion guard).
- Cursor: `nwse-resize` (or `ew-resize`) while over the handle.

## Edge cases

- **Window narrower than stored width:** render clamps to column width; the
  stored prop value is unchanged (restores when the window widens).
- **Sidebar open:** the page width is derived from the resolved width; sidebar
  remains laid out beside/over it as today. Default falls back to `480` when
  open, `600` when closed.
- **Very tall portrait page:** width is bounded by column width, so height is
  bounded by `columnWidth × aspectRatio`; acceptable. No separate height cap
  needed once width is clamped.
- **Multi-page nav / thumbnails:** unaffected; width applies to the currently
  displayed page.
- **Old markers without `width`:** `props.width` is `0` → default path → byte
  identical output until the user resizes.

## Verification

- Unit: serialize → parse round-trip for a `file` block with a numeric `width`
  (asserts the marker JSON carries `width` and parses back). Assert a marker
  _without_ `width` parses to `width: 0` (default) and re-serializes byte for
  byte unchanged when width stays default.
- Manual (live Electron in the worktree): embed a landscape PDF and a portrait
  PDF, drag the handle, confirm each scales aspect-correctly; reload the note
  and confirm the size persisted; inspect the vault `.md` and confirm the
  `width` field is present in the marker.

## Rollout / compat

- Purely additive prop with a safe default. No DB schema change, no sync
  contract change, no vault format break. Existing installs open older notes
  unchanged; newly-resized PDFs write a `width` field older app versions will
  simply ignore (unknown JSON key → dropped on their parse, falls back to
  default). Forward/backward tolerant.
