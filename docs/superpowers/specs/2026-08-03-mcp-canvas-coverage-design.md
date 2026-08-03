# MCP Canvas Coverage — read tools, item add/remove, write safety

- **Date:** 2026-08-03
- **Status:** Design approved, ready for implementation
- **Issue:** [#916](https://github.com/memrynote/memry/issues/916) — MCP: Canvas has zero coverage
- **Scope decision:** read + item add/remove, closing #916. Arrow authoring deferred with rationale (§8).
- **Related:** `docs/superpowers/specs/2026-07-17-spatial-canvas-design.md` (canvas architecture), #917 (project link layer), #921 / #922 (`settings.getFeaturesSettings` — unavailable when this was designed, allowlisted by #922)

---

## 1. Goal

Canvas shipped after `v2026-07-19.2` with zero MCP coverage: `window.api.canvas.*` has 10 operations,
none of which appear in either allowlist in `packages/contracts/src/agent-mcp-channels.ts`, and there
is no dedicated `vault_*` canvas tool. Agent Chat backends and external MCP clients cannot list, read,
or modify canvases at all.

After this work an agent can:

- list canvases and see **which notes/tasks/events live on one**, without raw scene geometry entering
  its context;
- put an existing entity **on** a canvas and take one **off**, producing valid Excalidraw elements;
- do both without silently destroying work the user has in an open editor.

### Non-goals

- **Arrow / binding authoring** — deferred, see §8.
- Free-form drawing, styling, or geometry edits by an agent.
- Any per-element CRDT for canvas. Canvas sync stays whole-document LWW + conflict copy
  (`main/sync/item-handlers/canvas-handler.ts`); this design does not change that.
- Agent access to the shape library beyond reading it (§3.2).

---

## 2. What the existing code already gives us

Two findings narrow the problem well below the issue's framing.

**2.1 Main already has an Excalidraw-free scene parser.**
`main/canvas/scene-refs.ts` `extractEntityRefsFromScene(scene)` parses a serialized scene and returns
deduped `{ entityType, entityId }` refs, built for the sync handler which runs in main. So:

- the read path needs **no renderer round-trip** — main can parse the scene itself;
- "re-derive `entityRefs` from the scene, never trust the caller" is already a solved, tested problem.

**2.2 `convertToExcalidrawElements` is a pure function, not an editor method.**
`canvas-card-overlay.tsx:329` calls it as a free function from `@excalidraw/excalidraw`; a mounted
editor is not required. This collapses the issue's A-vs-B fork: routing a write through _any_ renderer
window yields correctly-minted elements (`id`, `seed`, `version`, `versionNonce`, `updated`, fractional
`index`) whether or not the target canvas is open. There is no need to port skeleton→element logic
into main, and no upstream-drift maintenance burden.

The remaining question is therefore **not** "who mints elements" but "who owns the scene right now",
which is a concurrency question (§5), not an element-authoring one.

---

## 3. Read path

### 3.1 Dedicated tools (main-side, no window required)

**Vault key ownership.** `main/ipc/canvas-handlers.ts` holds a module-scoped `vaultKeyPromise` because
only the first `getOrInitializeLocalVaultKey` call in a process can initialize — a second caller throws
"verifier exists but master key is missing". Adding an MCP caller would make exactly that second call.
Extract the cached accessor into `main/canvas/vault-key.ts` (`getCanvasVaultKey()` /
`disposeCanvasVaultKey()`), and have both `canvas-handlers.ts` and the MCP handles use it. Behaviour is
unchanged; ownership moves from the IPC layer to the canvas module, which also keeps
`check:architecture` happy (the MCP adapter must not import from `main/ipc`).

**New pure module `main/canvas/summary.ts`.** One pass over the parsed scene producing:

```ts
interface CanvasSceneSummary {
  items: CanvasEntityRef[] // reuses the scene-refs card contract
  texts: string[] // element.type === 'text', skipping isDeleted
  elementCount: number // live elements
  textsTruncated: boolean
}
```

Caps: at most `MAX_TEXTS = 200` entries and `MAX_TEXT_CHARS = 20_000` total; exceeding either sets
`textsTruncated` and stops collecting. An unparseable scene yields an empty summary rather than
throwing, matching `extractEntityRefsFromScene`.

**Tools.**

| Tool                  | Input    | Output                                                                                |
| --------------------- | -------- | ------------------------------------------------------------------------------------- |
| `vault_list_canvases` | `{}`     | `[{ id, title, updated_at, item_count }]`                                             |
| `vault_read_canvas`   | `{ id }` | `{ id, title, created_at, updated_at, items, texts, element_count, texts_truncated }` |

`items` entries are `{ entity_type, entity_id, title, missing }`. Titles resolve main-side —
`getNoteById` (vault/notes), the tasks queries, and `getCalendarEventById`
(`main/calendar/repositories/calendar-events-repository.ts`). An entity that no longer exists reports
`missing: true` with `title: null` rather than being dropped, so an agent can see and report stale cards
instead of silently under-reporting what is on the canvas.

`item_count` on the list tool comes from the `canvas_entity_refs` rows (already maintained on every
save and on every sync apply), not from decrypting each scene — listing stays cheap.

Neither tool ever returns `scene`.

### 3.2 Allowlist — hybrid with deliberate exclusions

Added to `AgentMcpDesktopReadOperations`: `canvas.list`, `canvas.listAssets`, `canvas.getAsset`,
`canvas.libraryList`.

Added to `AgentMcpDesktopWriteOperations`: `canvas.create`, `canvas.delete`.

Deliberately **excluded**, with reasons:

| Operation            | Why it stays out                                                                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `canvas.get`         | Returns the full serialized scene — the exact geometry dump `vault_read_canvas` exists to avoid. Allowlisting it would reintroduce the problem through the back door.                |
| `canvas.update`      | Whole-scene replacement with no version check: hazard 2e in the issue. An agent cannot know a human is mid-drag. Item add/remove (§4) is the supported write path.                   |
| `canvas.librarySave` | Blob-shaped full-list reconcile — "absent from this payload" means delete (`canvas-handlers.ts:250`). An agent sending a partial list **silently deletes the user's shape library**. |
| `canvas.uploadAsset` | Binary payload over a JSON tool boundary; no coherent agent use case in v1.                                                                                                          |

Canvas creation is reachable through `vault_desktop_write` + `canvas.create` under the normal approval
gate, rather than a dedicated tool — the registry is already 58 tools and each additional one dilutes
model tool-selection.

These exclusions are encoded as **negative assertions** in
`packages/contracts/src/agent-mcp-channels.test.ts`, so a future "just add the rest of them" change
trips a test carrying the reason, the same way the Google Workspace Limited Use exclusions already work.

---

## 4. Write path — item add/remove

### 4.1 Architecture fork: resolved

Per §2.2, both branches of the issue's A-vs-B table are available from one renderer-routed
implementation. The write always goes to a renderer window; the renderer then picks a path based on
whether _that window_ has the target canvas mounted:

|                 | Canvas open in a window                                                                      | Canvas not open anywhere                                                           |
| --------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Path            | **Live**: `excalidrawAPI.updateScene(...)` on the mounted instance, then flush the persister | **Headless**: `canvas.get` → mutate → `canvas.update`                              |
| Element minting | `convertToExcalidrawElements` (already imported by that chunk)                               | `convertToExcalidrawElements` via dynamic `await import('@excalidraw/excalidraw')` |
| Concurrency     | Safe by construction — same instance, same autosave path                                     | `expectedUpdatedAt` optimistic guard (§5)                                          |
| User sees       | The card appear immediately                                                                  | Nothing until they open it                                                         |

The dynamic import matters: `CanvasEditor` is deliberately a lazy chunk so `@excalidraw/excalidraw`
and its CSS stay out of the main renderer bundle. The MCP write handler is always mounted, so it must
import the package at call time, not at module scope.

### 4.2 Live-canvas registry (two halves)

**Renderer-local**, `pages/canvas/canvas-live-registry.ts` — module-level `canvasId → { excalidrawAPI,
flush }`. The write handler needs the live Excalidraw instance to call `updateScene`, and the editor's
persister to force a save so the tool response reflects persisted state. `CanvasEditor` registers once
its API is available and unregisters on unmount, alongside the pending-save registration it already
does.

**Main-side**, `main/canvas/live-registry.ts` — `canvasId → windowId`, so main knows _which window_ to
send a write to:

- `CanvasEditor` reports `canvas:live-opened` / `canvas:live-closed` from the same effect;
- main drops entries for a window on its `closed` event, and treats a `BrowserWindow.fromId` miss as
  "not open" — a stale entry degrades to the headless path rather than failing the write.

Write routing: owner window if registered, else `ctx.windowId`, else the first live window. No live
window at all → `AgentToolError('UNAVAILABLE', ...)`; element minting requires a renderer. The renderer
handler re-checks its own registry rather than trusting main's routing, so a race between unmount and
the write in flight falls through to the headless path instead of touching a torn-down editor.

### 4.3 Shared pure scene edits

`renderer/src/pages/canvas/canvas-scene-edit.ts` — no Excalidraw import, so it unit-tests in jsdom.
Both paths call it; `convertToExcalidrawElements` is injected as a parameter.

- **add** — placement reuses `findFreeCardCenter`. Headless has no viewport, so the `SceneRect` is
  derived from the bounding box of existing live elements (empty scene → origin), which keeps new cards
  next to existing content instead of at an arbitrary point.
  Note cards size via `cardDefaultSize(entityType, markdown)`, with the markdown fetched the same way
  the picker path does it; every other type takes the compact card.
- **remove** — returns `{ elements, removedIds }` and scrubs all three places a deleted card is
  referenced:
  1. the card rectangles carrying that `{ entityType, entityId }` (there may be more than one);
  2. `startBinding` / `endBinding` on any arrow pointing at a removed id → `null`;
  3. `boundElements` entries on surviving elements referencing a removed id.

  Without (2) and (3) the scene keeps arrows bound to elements that no longer exist — the dangling-arrow
  criterion in the issue's acceptance list.

### 4.4 Tools

| Tool                       | Input                                                        | Notes                                                                |
| -------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------- |
| `vault_add_canvas_item`    | `{ canvas_id, items: [{ entity_type, entity_id }] }`, max 20 | Batch so "put these five tasks on it" is one approval for one intent |
| `vault_remove_canvas_item` | `{ canvas_id, entity_type, entity_id }`                      | Removes every card for that entity                                   |

Response: `{ canvas_id, added | removed, skipped, updated_at, too_large }`. `skipped` carries entities
already on the canvas (add) or not found on it (remove) with a reason — an agent should be able to tell
"already there" from "failed".

Entity existence is validated main-side before any element is minted, so an agent cannot create a card
pointing at nothing. `entityRefs` are re-derived from the mutated scene on every write and never taken
from the caller.

---

## 5. Write safety

**Optimistic concurrency.** `CanvasUpdateSchema` gains an optional `expectedUpdatedAt: number`. This is
additive and backward compatible: existing callers omit it and behave exactly as today (required by the
production back-compat rule — older app versions and the renderer's own autosave keep working
unchanged). `updateCanvas` compares it against the row **inside its existing transaction** and returns a
conflict result on mismatch; the handler surfaces `CANVAS_CONFLICT`. Comparing inside the transaction is
the point — a check-then-write outside it would be the same race in a longer coat.

Only the headless path passes it (with the `updatedAt` it just read). The live path does not need it: it
mutates the authoritative in-memory scene and lets the normal persister write.

**Too-large.** `canvas:update` currently emits `CanvasTooLargeEvent` and returns only the summary, and
MCP has no event subscription. The IPC response gains `tooLarge: boolean` (additive; the renderer
ignores the extra field and keeps using the event). The write tools surface it as `too_large` so an
agent bulk-adding cards learns the canvas stopped syncing instead of assuming success.

**Approval.** Both write tools go through the existing `WriteToolGate` like every other write tool —
they require an active Memry Agent conversation and the `X-Memry-Conversation` header, and a denied gate
yields `PERMISSION_DENIED`.

---

## 6. Feature flag

Canvas is behind `spatialCanvas` (default off). MCP tools **register unconditionally** and check the
flag at call time: the tool list is built once at `startAgentMcpLifecycle`, so gating registration would
mean enabling the flag mid-session does nothing until an app restart. A call with the flag off returns
an actionable error: `Spatial Canvas is disabled — enable it in Settings → Features`.

The flag is read via a new `main/settings/features.ts`. It deliberately does NOT reuse
`ipc/settings-handlers.ts`: that module reaches the settings query through the `@main/*` path alias,
which exists in `tsconfig.node.json` but not in the vitest resolver, so importing it makes the
importing module unloadable from a unit test.

The check lives in **two** places so there is no gap between surfaces: the canvas handles (dedicated
tools) and `desktop.read` / `desktop.write` for any operation starting with `canvas.` (allowlist
escape hatch). Without the second, an agent could reach `canvas.create` with the feature off.

(When this was designed `settings.getFeaturesSettings` was not allowlisted, so an agent could not
pre-check the flag — hence an actionable error rather than a bare refusal. #922 has since allowlisted
it, so an agent _can_ now check first; the actionable message stays, because an agent that does not
bother to check still deserves to be told what to do.)

---

## 7. Testing

| Area             | Test                                                                                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Allowlist        | `agent-mcp-channels.test.ts`: the six added ops present; `canvas.get`, `canvas.update`, `canvas.librarySave`, `canvas.uploadAsset` asserted **absent**, with the reason in the test name               |
| Scene summary    | `main/canvas/summary.test.ts`: text extraction, deleted-element skip, cap + `textsTruncated`, unparseable scene → empty                                                                                |
| Read tools       | Handles-level: item resolution, `missing: true` for a dangling ref, no `scene` key in any response                                                                                                     |
| Element validity | Round-trip: elements produced by the headless path are fed back through Excalidraw's restore and asserted unrepaired, and `extractEntityRefsFromScene` re-derives the same refs from the written scene |
| Scene edits      | `canvas-scene-edit.test.ts`: placement non-overlap, remove clears rectangles + both binding sides + `boundElements`                                                                                    |
| Routing          | Live registry: owner window wins; stale entry falls back to headless; no window → `UNAVAILABLE`                                                                                                        |
| Concurrency      | Store test: `expectedUpdatedAt` mismatch rejects and leaves the row untouched; omitted = no check                                                                                                      |
| Too-large        | Write tool reports `too_large: true` when the update could not sync                                                                                                                                    |
| Flag             | Every canvas tool and a `canvas.*` allowlist op error with the actionable message when the flag is off                                                                                                 |

Mocked-IPC tests give false confidence here (see the `mocked-ipc-tests-give-false-confidence` lesson):
the element-validity test must use the real `convertToExcalidrawElements`, not a stub, or it proves
nothing about the fields Excalidraw actually mints.

---

## 8. Arrows: out of scope, with rationale

Card rectangles are deliberately bindable (`canvas-cards.ts:334` — solid fill so the whole interior is a
binding target), so users already draw arrows between cards. An agent doing the same would have to author
an `arrow` with `startBinding` / `endBinding` (`focus` and `gap` are values Excalidraw derives
geometrically) **and** maintain `boundElements` on both rectangles — two-way bookkeeping for a purely
visual result.

The deciding argument is not effort, it is meaning: **nothing persists an arrow as a relationship**.
`canvas_entity_refs` records _which_ entities are on a canvas, never _how_ they relate. An agent drawing
arrows produces a picture, not queryable data, while inviting the caller to believe it created a link.
The relationship models that do exist are wikilinks / `notes.getLinks` (note ↔ note, already allowlisted)
and the project link layer (#917). A canvas-scoped semantic relation does not exist and would be a new
data model, not an MCP change.

Revisit if and when a canvas relation model lands.

---

## 9. Files touched

**Contracts**

- `packages/contracts/src/agent-mcp-channels.ts` — six operations added
- `packages/contracts/src/agent-mcp-channels.test.ts` — positive + negative assertions
- `packages/contracts/src/canvas-api.ts` — optional `expectedUpdatedAt`, `tooLarge` on the update response

**Main**

- `main/canvas/vault-key.ts` (new) — shared cached vault key
- `main/canvas/summary.ts` (new) + test — scene summarization
- `main/canvas/live-registry.ts` (new) + test — `canvasId → windowId`
- `main/canvas/store.ts` — `expectedUpdatedAt` check inside the update transaction
- `main/ipc/canvas-handlers.ts` — use the shared vault key; return `tooLarge`; live-registry IPC
- `main/settings/features.ts` (new) — alias-free `getFeaturesSettings()` for non-IPC callers
- `main/agent/mcp/tools/schemas.ts` — four tool schemas + name lists
- `main/agent/mcp/tools/read-tools.ts`, `write-tools.ts` — registrations
- `main/agent/mcp/tools/handles.ts`, `handles-adapter.ts` — `canvas` handle section, flag check on `canvas.*`
- `main/agent/mcp/tools/canvas-write.ts` (new) — routing to the owning window

**Renderer**

- `pages/canvas/canvas-scene-edit.ts` (new) + test — pure add/remove
- `pages/canvas/canvas-live-registry.ts` (new) — live Excalidraw handle per canvas
- `pages/canvas/canvas-editor.tsx` — register the live handle; report open/close to main
- `agent-mcp/canvas-write-handler.ts` (new) + test — live vs headless

**Docs**

- `apps/docs/src/user-guide/ai/agent-mcp.md` — tool list, excluded operations and why, flag behaviour
