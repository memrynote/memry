# MCP Canvas Drawing — shapes, text, arrows, frames

- **Date:** 2026-08-05
- **Status:** Implemented
- **Supersedes:** the "arrows out of scope" decision in
  `docs/superpowers/specs/2026-08-03-mcp-canvas-coverage-design.md` §8
- **Related:** `docs/superpowers/specs/2026-07-17-spatial-canvas-design.md` (canvas architecture)

---

## 1. Goal

After #916, an agent could list canvases, read what was on one, and put entity cards on and off it.
It could not draw. Asked to "put the notes from my book folder on a canvas and connect them", it
produced a pile of cards in a spiral with no structure, no labels and no arrows — the cards were
correct and the canvas was useless.

After this work an agent can author the rest of Excalidraw: rectangles, ellipses, diamonds, text,
arrows, lines, freedraw, frames, images and embeds; bind arrows to shapes and to cards already on the
canvas; group elements into frames; and move, restyle, retext or delete anything it drew.

### Non-goals

- Uploading binaries. Image elements need a `fileId` already attached to the canvas.
- Any per-element CRDT. Canvas sync stays whole-document LWW + conflict copy.
- A canvas relation model. An agent's arrow is a drawing, not a stored relationship (§6).

---

## 2. Reversing §8 of the coverage design

The earlier design deferred arrows on two arguments. One has aged well and one has not.

**"Two-way bookkeeping for a purely visual result"** — real, and it is exactly why this belongs in
one tested module rather than in each caller. `applyDrawPlan` writes both halves (the arrow's
`startBinding`/`endBinding` and the target's `boundElements`) and is unit-tested on the failure mode:
write only the first half and the arrow looks attached until the user drags the shape.

**"Nothing persists an arrow as a relationship"** — still true, and still worth saying out loud in
the docs. But it argues against _pretending_ an arrow is a link, not against drawing one. A canvas is
the one surface in memry whose entire purpose is spatial meaning that no query needs to understand.
Refusing to draw on it because the drawing is not queryable is refusing the feature.

---

## 3. Read path

`vault_read_canvas` stays exactly as it was: entities and text, never geometry. It is the right read
for "what is on this canvas" and shrinking it would be a regression.

`vault_read_canvas_elements` (new, main-side, Excalidraw-free) answers the other question — where
everything is. Per element: `id`, `type`, `x/y/width/height`, `text`, `label`, stroke/background,
`link`, arrow bindings by element id, `frameId`, and `entityType`/`entityId` for cards. Dropped:
`seed`, `version`, `versionNonce`, `index`, `points`, and everything else an agent would have to read
past. Capped at `MAX_ELEMENT_VIEWS` (1000) with `truncated`.

A shape's caption is its own text element pointing back at the shape, so captions are folded into
their container as `label` rather than reported as loose text an agent has to re-associate by
coordinates.

---

## 4. Write path

### 4.1 One channel, four ops

`AgentMcpCanvasWriteRequestSchema` becomes a discriminated union: `add` / `remove` (entity cards,
unchanged) plus `draw` / `edit`. They share the channel because they share the hard part — deciding
whether the target canvas is open, and not clobbering it either way. Live editor, headless
read-modify-write with `expectedUpdatedAt`, and the `entityRefs` recompute are untouched.

### 4.2 Ids are minted before conversion

`convertToExcalidrawElements` is called with `{ regenerateIds: false }` and skeletons that already
carry ids from `planDraw`. This is what makes the rest possible: bindings, frame membership and the
`ref → id` map in the response are all decided in one pure function, before Excalidraw is involved.

If upstream ever stops honouring `regenerateIds: false`, shapes still land but arrows come out
unbound. That degradation is silent by nature, so the handler compares minted ids against planned
ones and logs when they diverge.

### 4.3 Bindings are wired here, not by the skeleton API

The skeleton API resolves `start`/`end` only against elements in the same batch. An agent's most
valuable arrow is the one pointing at a card that is _already_ on the canvas, so bindings take one
uniform path in `canvas-draw-plan.ts` — same-batch and pre-existing alike:

1. resolve each endpoint to an element id (`ref` → this batch, `elementId` → the scene);
2. compute the arrow's geometry from both boxes (`edgePoint`: the point on the box along the line to
   the other end, pushed out by the binding gap) — Excalidraw recomputes this when either shape
   moves, but only _after_ a move, so an arrow whose points were never right looks wrong until the
   user drags something;
3. after conversion, write `startBinding`/`endBinding` on the arrow and push the arrow into the
   target's `boundElements`.

Frames follow the same reasoning: `children` passed to the skeleton API is filtered to same-batch
ids, and every child — new or pre-existing — gets `frameId` set afterwards.

### 4.4 `customData` is not in the schema

A card is a rectangle carrying `customData: { entityType, entityId }`, and `canvas_entity_refs` is
rewritten from exactly that on every save. An agent that could set it would mint a card for an entity
nobody validated, or for one that does not exist. Cards go through `vault_add_canvas_item`, which
checks. `vault_edit_canvas_elements` will move and restyle a card but refuses to rewrite its text —
that text lives in the note.

### 4.5 Field naming

Element fields are Excalidraw's own, in camelCase (`strokeColor`, not `stroke_color`). Every model
that has seen the Excalidraw programmatic API already knows this vocabulary; a memry-specific
renaming would only be a layer to get wrong. Tool arguments around them stay snake_case
(`canvas_id`, `elements`), matching every other tool.

### 4.6 Limits

`MAX_DRAW_ELEMENTS` / `MAX_EDIT_ELEMENTS` 300 per call; `MAX_SCENE_ELEMENTS` 5000 per canvas, so a
looping agent cannot grow a canvas until it stops opening. `link` accepts http(s) only — an element
link is a thing the user clicks, and `file:`/`javascript:` reaching the shell from agent-authored
content is not a door worth opening for a drawing feature.

---

## 5. `vault_create_canvas` goes through the desktop bridge

It calls the already-allowlisted `canvas.create` desktop operation rather than the store directly.
The IPC handler is what enqueues the sync item and emits `canvas:created`; a canvas created without
those is invisible to the sidebar and never reaches the user's other devices.

---

## 6. What an arrow still is not

Nothing queries it. `canvas_entity_refs` records _which_ entities are on a canvas, never _how_ they
relate, and this design does not change that. The relationship models that exist are wikilinks
(`notes.getLinks`) and the project link layer. The docs say so plainly so a caller does not read an
arrow as a link it can later follow.

---

## 7. Files touched

| File                                                    | Change                                         |
| ------------------------------------------------------- | ---------------------------------------------- |
| `packages/contracts/src/canvas-draw.ts`                 | new — element/edit schemas, element view       |
| `packages/contracts/src/agent-mcp-channels.ts`          | write request becomes a 4-op union             |
| `apps/desktop/src/main/canvas/elements.ts`              | new — Excalidraw-free structural scene read    |
| `apps/desktop/src/renderer/.../canvas-draw-plan.ts`     | new — pure planner, bindings, frames, edits    |
| `apps/desktop/src/renderer/.../canvas-scene-edit.ts`    | `dropElements` extracted; element type widened |
| `apps/desktop/src/renderer/.../canvas-write-handler.ts` | draw/edit ops                                  |
| `apps/desktop/src/main/agent/mcp/tools/*`               | 4 new tools, canvas handles                    |
| `apps/docs/src/user-guide/ai/agent-mcp.md`              | canvas section rewritten                       |
