# Spatial Canvas M6 — In-place Live Editing — Design

Date: 2026-07-21 · Branch: `spatial-canvas-m6-live-editing` (off `origin/main`) · Status: design, awaiting approval

Companion to the master plan `docs/superpowers/specs/2026-07-17-spatial-canvas-design.md` (read §7.1, §13 M6, §15 R15–R19, §18 C1–C6 / E1–E2, edge-case matrix #18–22). This doc records the M6-specific architecture and the decisions the master spec left open. Where they conflict, this doc wins for M6.

## 0. Context

M0–M5 are merged to `main` (base = `5e829ed74`, the M5 asset commit — so there is **no #815 conflict**). M2 already shipped the hybrid card system: an Excalidraw `rectangle` per card (`customData:{entityType,entityId}`) plus a `pointer-events:none` DOM overlay rendering **read-only static previews**, transform-synced imperatively (C1/C2), with virtualization (hysteresis) and `data-canvas-card-*` E2E hooks. **M6 upgrades the idle→active transition; it does not rebuild the overlay.**

The `spatialCanvas` flag is already in `FEATURE_KEYS`, **default-OFF**. M6 does **not** touch the flag, its default, sync, contracts, crypto, or DB. M6 is renderer-side editing over existing entities.

## 1. Decisions locked (2026-07-21)

- **D1 — R17 co-edit = shared Y.Doc registry.** A note open in a tab _and_ active on a canvas card is two BlockNote editors on one note in one renderer window. Today's `useYjsCollaboration` makes a fresh `Y.Doc` per mount; main's `crdt-provider` broadcasts to _other_ windows (excludes the source window) and ref-counts by `windowId` — so two same-window editors would **diverge** (not echo) and the first unmount would **destroy the doc under the second**. Fix: a renderer-side, ref-counted, `noteId`-keyed registry that owns **one** `Y.Doc` + **one** `YjsIpcProvider`; both editors bind the **same** `Y.XmlFragment`, so sibling edits propagate in-memory via `y-prosemirror` (idempotent → no dup blocks). Meets exit-criterion #19.
- **D2 — Task card editor = slim field subset.** Reuse the standalone field components the drawer already composes (title, status, priority, due date, description) in a compact `<CanvasTaskEditor>`; do **not** extract the full `<TaskDetailBody>` (subtasks / related-notes / repeat / reminders overflow a card and drag in the tasks-page query/undo infra). Writes route through the existing `use-task-queries.ts` `updateTask` mapper — never a reimplemented `tasksService.update`.
- **D3 — Event card editor = extract `<CalendarEventForm>`** from `calendar-event-popover.tsx` (E1). The popover body (`:249–352`) is a fully-controlled dumb form; lift it + `submit`/`handleAllDayToggle`/`errorMessage`/`titleRef` into `<CalendarEventForm>`; the popover becomes a thin wrapper (no caller regression). Card owns the `CalendarEventDraft` and saves via `calendarService.updateEvent`.
- **D4 — Hit-test = angle-aware.** Extract a pure `hitTestCard(cards, scenePoint)` (reverse-z, rotates the point into each card's local frame). Cards may still rotate; hit-testing stays correct without forbidding rotation (C3's "or make overlay angle-aware" branch).

## 2. Non-goals / out of scope for M6

- No flag flip / `FEATURE_KEYS` change / i18n features entry (that is M7).
- No sync / contract / crypto / DB / migration change.
- No `renderEmbeddable` (E2/R19 — overlay stays primary; spike already de-scoped).
- No task/event **capture-first** on canvas (§17-Q1). M6 edits cards that already reference an entity; task/event cards are seeded programmatically in tests. The existing "New note" capture button stays.
- No new IPC channel (`ipc-contract-change` not needed).
- No canvas-arrows-to-backlinks (§8).

## 3. Active-card state machine

Single source of truth in `CanvasCardLayer`: `activeCardId: string | null` (an Excalidraw `elementId`). Invariant: **at most one** active card; activating a second deactivates the first (its editor unmounts before the new one mounts).

The testable logic goes in a pure module (`canvas-active.ts`) so jsdom can cover it without canvas geometry:

- `hitTestCard(cards, {x, y}): CanvasCardRef | null` — reverse-z, angle-aware (D4).
- `shouldDeactivateForTool(activeToolType): boolean` — true when the user picks a non-`selection` Excalidraw tool (C4 toolbar-select deactivate).
- `nextActive(prev, event): string | null` — reducer for `activate(id)` / `deactivate()` / `cardGone(id)`.
- `withActivePinned(visibleIds, activeCardId): Set<string>` — force-includes the active card in the mounted set so a stray recompute never unmounts a live editor mid-edit.

Deactivation triggers: click-away pointerdown outside the active card; Escape (swallowed); non-selection tool chosen; the active card leaving the scene / going dangling / unmounting.

## 4. Pointer model (C3/C4) + the early spike

**R15 is the central UX risk — spike this flow FIRST, before building the three editors.**

- **Idle → Active:** capture-phase `dblclick` on the wrapper (listener already exists) → `viewportCoordsToSceneCoords` → `hitTestCard` → on hit: `e.preventDefault()` + `e.stopPropagation()` (so Excalidraw does **not** open the rectangle's bound-text editor, C3) → `activate(elementId)`. Guard: ignore dblclicks whose `target` is inside the ↗ redirect button (`closest('[data-canvas-redirect]')`) so ↗ and edit never cross-fire (#20).
- **Active card captures input:** the active card's container div sets `pointerEvents:'auto'` (re-enabling events within a `pointer-events:none` ancestor). Everything else in the overlay stays `pointer-events:none`, so pan/draw/select still work everywhere else.
- **Active → Idle (C4):**
  - **Click-away:** a capture-phase `pointerdown` on the wrapper; if `target` is not inside the active card → `deactivate()` **without** `stopPropagation` (the same click also pans/selects/draws — "one click deactivates and performs the canvas action"). Starting a pan is itself a click-away, which naturally deactivates.
  - **Escape:** the active-card container's `onKeyDown` → on `Escape`, `deactivate()` + `stopPropagation()` (swallowed).
  - **Tool-select:** `recompute` (runs on every `onChange`) reads `appState.activeTool.type`; if a card is active and `shouldDeactivateForTool` → `deactivate()`.
- **Keyboard containment:** the active-card container `stopPropagation`s `keydown`/`keyup` so Cmd/Ctrl+Z belongs to the editor (BlockNote undo), not Excalidraw. **Spike must verify** bubble-phase `stopPropagation` actually contains Excalidraw's shortcuts — Excalidraw binds some **capture-phase** document listeners, so if bubble-phase is insufficient the fallback is a `document`-level capture listener, active only while a card is active and gated on `target` ∈ active card. Record the spike outcome in §12.

Card move/resize stays driven by the underlying rectangle (drag rectangle → `onChange` → overlay follows). The overlay never gets its own drag logic.

## 5. R17 — the shared Yjs doc registry (note editor)

### 5.1 Registry

New `renderer/src/sync/yjs-doc-registry.ts`: a module-level `Map<noteId, Entry>` where `Entry = { doc, provider, fragment, refCount, sideEffectOwner: symbol | null, … }`.

- `acquire(noteId): Entry` — first acquirer creates `doc` + `YjsIpcProvider` + `connect()` (exactly today's `useYjsCollaboration` body), `refCount = 1`, and becomes `sideEffectOwner`. Subsequent acquirers `refCount++` and share the same `doc`/`fragment`.
- `release(noteId, consumerId)` — `refCount--`; at 0, `provider.destroy()` + `doc.destroy()` (one `closeDoc`). If the releaser was `sideEffectOwner`, promote a remaining consumer.

`useYjsCollaboration(noteId, enabled)` becomes a thin wrapper over `acquire`/`release` keyed to the component lifecycle. **Parity mandate:** for `refCount === 1` (the universal non-canvas case) behavior is byte-identical to today — one create on mount, one destroy on unmount. Only `refCount ≥ 2` (canvas + tab, same note, same window) exercises new sharing. This is the blast-radius containment; it is covered by dedicated unit tests (refcount-1 == today; refcount-2 shares one doc; teardown at 0 only).

### 5.2 Single side-effect owner

`ContentAreaEditor.onChange` runs task auto-conversion + markdown writeback; two live editors would double-fire. Add an additive prop `runSideEffects?: boolean` (default `true`) to `ContentArea`, driven by the registry: an editor runs side effects **iff** it is the current `sideEffectOwner` for its `noteId`. In practice the tab (first mount) owns side effects and the card is passive; a canvas-only note (no tab) makes the card the owner. Markdown writeback stays gated off under Yjs as today (main owns persistence); only task auto-conversion needs the single-owner gate.

### 5.3 Embedded note editor

`<EmbeddedNoteEditor noteId>` = the **outer** `<ContentArea noteId={noteId} />` in a bounded, scrollable container with the BlockNote CSS already imported by ContentArea. No `note.tsx` chrome, no fragment threading — the registry makes the outer ContentArea share transparently when the same note is also in a tab. The canvas route already sits under every provider ContentArea reads (`SyncProvider` from `main.tsx`; AI/Tasks/Tabs/Theme/SidebarDrillDown from `App.tsx`; it renders through the same `tab-content.tsx` as the note page), so the mount is safe.

## 6. The three active editors

Rendered by a thin `<CanvasCardActive>` container (pointer-events:auto, key containment, Escape→deactivate) that switches on `entityType`:

- **note** → `<EmbeddedNoteEditor noteId>` (§5).
- **task** → `<CanvasTaskEditor taskId>` (D2). Fetches the UI-model task (lift the pre-mapped task from the tasks query, or `tasksService.get` + wire→UI map); renders title / `InteractiveStatusBadge` / `InteractivePriorityBadge` / `InteractiveDueDateBadge` / `TaskDescriptionEditor`; every field autosaves via the shared `updateTask` mapper (`onUpdateTask(id, patch)` semantics). No submit button (inline autosave sidesteps the disable-mid-click trap). Description editor keeps `key={task.id}` + unmount flush.
- **calendar_event** → `<CanvasEventEditor eventId>` rendering `<CalendarEventForm mode="edit">` (D3). Seeds `CalendarEventDraft` from `calendarService.getEvent`; `onSave` → `calendarService.updateEvent({ id, ...toCreatePayload(draft) })`; Save fires on `onPointerDown` (preserve the popover's pattern; convert local wall-clock draft → ISO via the existing `localInputToIso`).

Only the **one** active card mounts a heavy editor (R16). Idle cards stay static previews.

## 7. Virtualization × active editor

The active card is pinned into the mounted set (`withActivePinned`) so a recompute never unmounts it mid-edit. Because starting a pan is a click-away that deactivates, the pinned editor is short-lived and does not fight virtualization. The 200-card + heavy-ink perf gate (matrix #16, moved to M2) must still pass with one active editor mounted.

## 8. Redirect stays distinct (#20)

Unchanged: the ↗ button (`data-canvas-redirect`) → `redirect()` → `buildRedirectTab` → `openTab` (note→note tab, task→tasks + `openTaskId`, event→calendar focus). Double-click → `activate()`. The dblclick guard (§4) skips the ↗ button so the two never cross-fire.

## 9. File-level delta plan

New (mostly pure / thin glue, to protect the ratchet):

- `pages/canvas/canvas-active.ts` — reducer + `hitTestCard` + `shouldDeactivateForTool` + `withActivePinned` (unit-tested).
- `pages/canvas/canvas-card-active.tsx` — active container + editor switch (thin).
- `pages/canvas/embedded-note-editor.tsx` — `<ContentArea>` in a box.
- `pages/canvas/canvas-task-editor.tsx` — slim task fields.
- `pages/canvas/canvas-event-editor.tsx` — `<CalendarEventForm>` host.
- `sync/yjs-doc-registry.ts` (+ test) — the ref-counted registry.
- `tests/e2e/canvas-editing.e2e.ts` — matrix #18–22.

Edited:

- `pages/canvas/canvas-card-overlay.tsx` — `activeCardId` state; dblclick → activate (via `hitTestCard`); click-away pointerdown; tool-select deactivate; render active vs idle; pin active.
- `sync/use-yjs-collaboration.ts` — route through the registry (parity-preserving).
- `components/note/content-area/ContentArea.tsx` (+ `types.ts`) — additive `runSideEffects?` gate.
- `components/calendar/calendar-event-popover.tsx` — extract `<CalendarEventForm>`, wrap it.
- `components/tasks/*` — only if a field component needs a tiny prop to render standalone (prefer zero edits).
- `packages/i18n/src/locales/en/common.json` — new `canvas.*` strings (i18n:check is en-only).

## 10. Testing strategy

- **Unit (jsdom/node):** `canvas-active.ts` (activate/deactivate reducer, angle-aware hit-test, tool-gate, pin membership); `yjs-doc-registry.ts` (refcount-1 parity, refcount-2 shares one doc, teardown-at-0, side-effect-owner promotion); pointer-events gating helper.
- **E2E (Playwright + Electron, `canvas-editing.e2e.ts`), extending `canvas-cards.e2e.ts` harness** (`setSpatialCanvasFlag`, `seedNote`, synthetic-DragEvent card seed, `window.api.canvas.get`, `data-canvas-card-*`):
  - #18 dblclick note card → type body → `notes.get` persists → note tab reflects live.
  - #19 note in tab + active on card → edits both ways, no dup/echo blocks.
  - #20 ↗ opens correct tab/drawer/focus; dblclick edits in place; no cross-fire.
  - #22 task + event in-place edits persist via `tasks`/`calendar` IPC; live preview updates.
  - #21/#16 click-away/Escape → idle + unmount; 200-card + heavy-ink + one active editor pans/zooms; off-screen cards unmount.
  - Seed task/event cards programmatically (synthetic DragEvent with `entityType:'task'|'calendar_event'`).
- Gates: `pnpm typecheck && pnpm lint && pnpm ipc:check && pnpm i18n:check && pnpm check:architecture && pnpm check:contracts`; desktop + sync-server suites; coverage ratchet green. Tailwind logical props for any new UI.

## 11. Backward-compat, risk, coverage

- Backward-compat is trivially satisfied: no flag/sync/contract/crypto/DB change. The registry refactor is renderer-only and preserves single-editor behavior exactly.
- Highest risk is the registry (core note-editing path). Mitigations: refcount-1 parity tests, spike-first, and the change is inert for every user until a canvas card and a note tab coexist (canvas is default-OFF).
- Keep overlay glue thin; put logic in the pure modules so untestable canvas code doesn't drag the ratchet.

## 12. Open verifications (filled by the spike, before building the editors)

1. Keyboard containment: does bubble-phase `stopPropagation` on the active card contain Excalidraw's Cmd+Z / Escape, or is a gated capture-phase document listener required? **Spike result (Task 2):** bubble-phase `stopPropagation` on `CanvasCardActive` is sufficient — verified via E2E with a reliable signal (the card's live Excalidraw element count, not raw scene-JSON string diffing, which false-positived on incidental selection/appState changes from the activating double-click itself). With containment fully disabled as a control, the card's rectangle was still never touched by Ctrl/Cmd+Z: Excalidraw's core `onKeyDown` is bound only as a React `onKeyDown` prop on its own `.excalidraw` container (`handleKeyboardGlobally` defaults to `false` and `canvas-editor.tsx` never sets it), and `CanvasCardLayer`/`CanvasCardActive` mount as a DOM/React sibling of `<Excalidraw>`, not a descendant — so the event structurally never reaches Excalidraw's handler regardless of stopPropagation. No capture-phase document listener was added.
2. Click-away feel: one pointerdown both deactivates and performs the canvas action, without a lost first click.
3. Two `y-prosemirror` `UndoManager`s on one shared doc: confirm undo/redo in tab and card don't clobber each other.
4. `renderEmbeddable` stays closed (no work); overlay is primary.
