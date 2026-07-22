# Spatial canvas — "Add card" picker (task & calendar-event entry path)

**Date:** 2026-07-22
**Status:** design approved, not implemented
**Base branch:** `origin/spatial-canvas-m7-rollout` (see §8 — the docs this
corrects live only on that branch)
**Feature flag:** rides behind `spatialCanvas` (default-off). No released-user
exposure.

---

## 1. Problem

The canvas supports three card entity types — `note`, `task`, `calendar_event`.
Task and event cards render ([canvas-card.tsx][cc]) and edit in place
([canvas-task-editor.tsx][cte], [canvas-event-editor.tsx][cee]) correctly, and
the drag payload helper handles all three ([canvas-cards.ts][ccs]).

There is **no UI path to place a task or event card on a canvas.** A repo-wide
search for `canvasDragPayload` / `CANVAS_ITEM_DRAG_MIME` finds exactly one
production call site — [virtualized-notes-tree.tsx:938][vnt], which tags notes
in the sidebar tree. Nothing in `pages/tasks.tsx` or `pages/calendar.tsx` sets
it, and the in-canvas pill ([canvas-card-overlay.tsx:378][cco]) creates notes
only.

Discovered while writing the M7 user documentation, which currently describes
this as a limitation rather than a feature.

## 2. Why not drag-from-existing

The obvious symmetric fix — add a drag source to task rows and calendar chips —
is the **larger** step here, not the smaller one. Two independent blockers:

1. **Co-visibility.** Note drag works because the sidebar tree is always on
   screen beside the canvas. Tasks and events live inside _tab pages_; opening
   the Tasks tab replaces the canvas tab. A drag source there only functions in
   split-view — a narrow, poorly discoverable path.
2. **Mechanism conflict.** Task rows and calendar chips are @dnd-kit
   ([draggable-task-row.tsx:24][dtr], [draggable-task-chip.tsx:14][dtc]), which
   never populates `dataTransfer` — precisely what the canvas drop handler
   reads. Adding native `draggable` would also contend with the existing pointer
   sensors for reorder and date-move.

The master spec already anticipated this. §7.3 of
`2026-07-17-spatial-canvas-design.md`: _"Tasks use @dnd-kit (not native
dataTransfer) — dragging a task to canvas needs a separate bridge or an 'add
task to canvas' action; do not promise task-drag via the note-tree path."_

An in-canvas picker is layout-independent, needs no dnd bridge, and lands where
the user already is.

## 3. Approach

Extend the existing bottom-center pill into **"Add card"** — a picker that
searches notes, tasks, and events, with "Create new note" as its first row.
One affordance replaces one affordance. Sidebar note-drag is unaffected.

## 4. Components

| File                                 | Purpose                                                            | Depends on                  |
| ------------------------------------ | ------------------------------------------------------------------ | --------------------------- |
| `canvas-add-card.ts` _(new)_         | Pure: merge + group results, mark on-canvas, compute reveal scroll | contracts types only        |
| `use-canvas-add-search.ts` _(new)_   | Fetch + debounce the two sources                                   | search & calendar services  |
| `canvas-add-card-dialog.tsx` _(new)_ | cmdk picker UI                                                     | `components/ui/command.tsx` |
| `canvas-card-overlay.tsx` _(edit)_   | Pill label/testid + three result handlers                          | above                       |

`canvas-add-card.ts` imports no React and no Excalidraw — the same discipline
[canvas-cards.ts][ccs] already follows, so its logic unit-tests without either
library.

## 5. Data sources

- **Notes + tasks:** `searchService.quick(text)`, filtered to
  `type: 'note' | 'task'`.
- **Events:** one `calendar.getRange({ startAt: now−90d, endAt: now+90d })` on
  dialog open; title filtering client-side. `calendar:list-events` accepts only
  `{ includeArchived }` — no query, no range, no limit
  ([calendar-api.ts:74][cal]) — so it would decrypt and ship every event on
  every picker open. The bounded range is the deliberate trade: events beyond
  ±90 days are unreachable in v1.

**Excluded:** `journal` and `inbox` search hits. Neither is a `CanvasEntityType`,
and it is unverified whether a journal hit carries a usable note id. Revisit
separately.

## 6. Behavior

- **Empty query** → single "Create new note" row, preserving today's one-click
  path.
- **Typing** → three groups: Notes / Tasks / Events. The "Create new note" row
  **stays pinned at the top** and is exempt from filtering, so it never
  disappears mid-type. Its label carries the typed text (`Create note
"groceries"`), making it double as titled-note capture. When there are real
  matches, the **first match** takes the initial highlight, so Enter picks an
  existing item rather than creating a note; reaching the create row is one
  arrow-up.
- **Pick a fresh item** → card at viewport center, reusing `createCardElement`
  and the `viewportSceneRect` midpoint math already in `handleCreateNote`
  ([canvas-card-overlay.tsx:299][cco]).
- **Pick an item already on this canvas** → _reveal_, not duplicate. Rows carry
  an "On canvas" badge, computed from `getCardRefs(scene)`. Selecting one
  centers the viewport on that card and flashes it via `selectedElementIds`.

Reveal keeps one card per entity, so `extractEntityRefs` stays 1:1 and arrows
don't fragment across duplicates. It also avoids two live editors for one entity
on a single canvas — the in-tab form of the M6 split-view clobber hazard.

**Reveal implementation.** `revealScroll(card, containerSize, zoom) →
{scrollX, scrollY}` as a pure function, applied through `updateScene`. This is
the guaranteed path and the unit-testable one, and matches the M2 C1
imperative-transform precedent. Excalidraw's `scrollToContent` may be cleaner;
it is **unverified** — this worktree has no installed `node_modules`, so
confirming it is a plan-time step, not an assumption.

## 7. Testing

- **Unit** — `canvas-add-card.ts`: merge/grouping, on-canvas marking, reveal math.
- **Component** — dialog renders three groups, the badge, and the create-new
  row. The known jsdom picker gotcha may apply to `CommandDialog`; verify early.
- **E2E** — picker → task card present, asserted via
  `page.evaluate(id => window.api.canvas.get(id))` per master-spec B4. No pixel
  assertions.
- **Migrated** — the M6 e2e asserting `data-testid="canvas-new-note"` moves to
  `canvas-add-card` + the "Create new note" row. The testid is renamed because
  the element genuinely changes meaning; leaving it would misname the affordance
  for the next reader.

## 8. Docs

The pages this corrects exist **only** on `origin/spatial-canvas-m7-rollout`
(`0f642d48c`), not on `main`. Hence the base-branch choice: feature and docs land
together, so the limitation text is never simultaneously published and false.

- `apps/docs/src/user-guide/canvas/cards-and-links.md` — lines ~12–15 ("the only
  way to add a card is dragging a note from the sidebar or the **New note**
  button… There is no drag-in from the Tasks or Calendar pages yet") become a
  description of the picker.
- `apps/docs/src/user-guide/canvas/sync-and-limits.md` — lines ~40–42 drop the
  "Adding a task or calendar-event card requires the note-drag or New note"
  limitation. The ±90-day event range replaces it as an honest, narrower limit.

Run `pnpm docs:impact --base <base_commit> --strict` and `pnpm docs:build`.

## 9. Out of scope

- **Capture-first task/event.** Master spec §17 Q1 is unresolved — a blank task
  needs a `projectId` (inbox?) and a blank event needs a `startAt` (now?). The
  picker deliberately does not force that decision; only "Create new note"
  creates anything.
- **Drag from Tasks/Calendar pages.** Per §2.
- **Events beyond ±90 days.** Per §5. Widening the range, or a proper
  `calendar:search-events` channel, is the natural follow-up.
- **Indexing events into global search.** Best long-term UX (one query covers
  all three) but touches the index DB and indexer — well beyond this feature.

## 10. Compatibility

Renderer-only. No DB schema, sync protocol, IPC contract, vault format, or
settings change. Nothing to migrate.

<!-- anchors -->

[cc]: ../../../apps/desktop/src/renderer/src/pages/canvas/canvas-card.tsx
[cte]: ../../../apps/desktop/src/renderer/src/pages/canvas/canvas-task-editor.tsx
[cee]: ../../../apps/desktop/src/renderer/src/pages/canvas/canvas-event-editor.tsx
[ccs]: ../../../apps/desktop/src/renderer/src/pages/canvas/canvas-cards.ts
[cco]: ../../../apps/desktop/src/renderer/src/pages/canvas/canvas-card-overlay.tsx
[vnt]: ../../../apps/desktop/src/renderer/src/components/virtualized-notes-tree.tsx
[dtr]: ../../../apps/desktop/src/renderer/src/components/tasks/drag-drop/draggable-task-row.tsx
[dtc]: ../../../apps/desktop/src/renderer/src/components/calendar/draggable-task-chip.tsx
[cal]: ../../../packages/contracts/src/calendar-api.ts
