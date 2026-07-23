# Canvas drag & drop: place items without the Add-card picker

Date: 2026-07-23
Status: approved, ready for implementation
Branch: `canvas-drag-drop-items`

## Problem

Putting an item on a spatial canvas today means opening the Add-card picker and
searching for it. Search is the _only_ path for tasks and calendar events. That
is backwards when the item is already on screen — in the sidebar tree, in a
task list in the other split pane, or on the calendar.

Sidebar notes are the exception: they already drag onto a canvas. The gap is
every other entity kind.

Goal: any canvas-placeable item that is visible anywhere in the app can be
dragged onto an open canvas and becomes a card at the drop point. The picker
stays, but stops being mandatory.

## Scope

| Source surface                          | Today                               | After                                   |
| --------------------------------------- | ----------------------------------- | --------------------------------------- |
| Sidebar note tree                       | native HTML5 drag → card (works)    | unchanged                               |
| Task row (list, kanban, today, project) | dnd-kit draggable, no canvas target | drops onto canvas; **no source change** |
| Calendar event chip (day/week/month)    | not draggable                       | `useDraggable` added                    |
| Calendar task chip                      | dnd-kit (reschedule)                | also drops onto canvas                  |
| Inbox item                              | —                                   | **out of scope**                        |

### Why inbox is out of scope

`CANVAS_ENTITY_TYPES` is `['note', 'task', 'calendar_event']`
(`packages/contracts/src/canvas-api.ts`). Adding `inbox_item` would touch the
contract enum, `canvas_entity_refs`, the card renderer (voice / clip / pdf /
reminder previews each differ), the entity resolver, the redirect-tab builder,
and would need older app versions to tolerate a card type they cannot render —
a sync/back-compat problem for a live beta. Inbox items are also transient:
filing one already produces a note or a task, which _are_ placeable. Deferred
as its own piece of work.

### Removal

Deleting a card is already Excalidraw's own delete (select + Backspace);
`extractEntityRefs` rewrites `canvas_entity_refs` on the next save. No new work.

## Approach

Two drag mechanisms exist in the app and both stay:

- **Native HTML5 DnD** — the note tree writes `CANVAS_ITEM_DRAG_MIME`
  (`application/x-memry-canvas-item`); the canvas already consumes it in a
  capture-phase `drop` listener.
- **dnd-kit** — `DragProvider`'s `DndContext` is mounted at the app root
  (`App.tsx`), so _every_ pane, including a canvas in a split view, is inside
  one drag context. Task rows spread dnd-kit listeners on the row root
  (`components/tasks/drag-drop/task-row.tsx`), so a native `draggable` on the
  same element would make two drag systems race on one pointerdown.

Therefore the canvas becomes a **dnd-kit droppable** in addition to its
existing HTML5 drop target. Task rows need no change at all; calendar event
chips gain a `useDraggable`.

The canvas listens for its own drops with `useDndMonitor` rather than routing
through `App.tsx`'s `handleDragEnd`. `App.tsx` stays untouched, and a canvas in
each split pane registers its own droppable id — no central registry of which
pane holds which canvas.

`DragProvider` ignores any drag whose `data.type` is not
`task` / `calendar-task` / `subtask` (`contexts/drag-context.tsx`), so the new
`canvas-entity` drag type cannot disturb task drag state, multi-select, or the
drag overlay.

### Duplicates

A drop always creates a card, including for an entity that already has one.
Multiple cards for one entity are legal — the same note can appear in two
clusters — and `extractEntityRefs` already dedupes the persisted refs.

Known inconsistency, accepted: the Add-card picker still marks and blocks
entities that are already on the canvas (`onCanvas`). Drag and picker will
disagree. Relaxing the picker is a separate decision.

## Components

### 1. `pages/canvas/canvas-drop-entity.ts` (new, pure)

React- and Excalidraw-free, mirroring `canvas-cards.ts` so it unit-tests
without either library.

- `CANVAS_DROP_DATA` — the `data` object the canvas droppable registers,
  `{ type: 'canvas' }`.
- `entityFromDndData(data): CanvasEntityRef | null` — maps a dnd-kit
  `active.data.current` to a canvas entity:
  - `type: 'task' | 'calendar-task' | 'subtask'` → `{ entityType: 'task', entityId }`,
    reading the id from `task.id` / `taskId` / the draggable id passed in.
  - `type: 'canvas-entity'` → `{ entityType, entityId }` read from the payload,
    validated against `CANVAS_ENTITY_TYPES`.
  - anything else → `null`.
- `entitiesFromDrag(activeData, activeId, draggedTasks): CanvasEntityRef[]` —
  expands a multi-select task drag (dnd-kit's `dragState.draggedTasks`) into one
  ref per task; a single-item drag returns one ref; an unrecognised drag returns
  `[]`.
- `pointerFromDragEnd(activatorEvent, delta): { clientX, clientY } | null` —
  dnd-kit reports no drop coordinate, so the pointer position is the
  pointerdown coordinate plus the drag delta. Returns `null` when the activator
  event carries no coordinates (keyboard sensor).

### 2. `pages/canvas/canvas-card-overlay.tsx` (extended)

- `useId()` gives a droppable id unique to this mounted overlay, i.e. per open
  canvas pane; `useDroppable({ id, data: CANVAS_DROP_DATA })`. `setNodeRef` is
  pointed at `wrapperRef.current` from an effect (the wrapper element is owned
  by the editor, not created here).
- `useDndMonitor({ onDragEnd })`: when `over?.id` is this droppable's id,
  resolve refs with `entitiesFromDrag`, resolve the pointer with
  `pointerFromDragEnd`, convert to scene coordinates with
  `viewportCoordsToSceneCoords`, and create the cards.
- `createCardElement` generalises to `createCardElements(refs, centerX, centerY)`:
  the first card is centred on the drop point, each subsequent one is placed by
  `findFreeCardCenter` so a multi-select drop tiles instead of stacking.
  A single-item drop keeps today's behaviour exactly.
- Drop affordance: when `isOver` and the active drag resolves to at least one
  entity, the wrapper shows a dashed ring. Purely visual.
- The existing capture-phase HTML5 `dragover`/`drop` listeners are untouched.

### 3. Calendar event chips

A wrapper around `CalendarItemChip` (alongside the existing
`DraggableTaskChip`) registers, for `item.sourceType === 'event'`:

```
useDraggable({
  id: `canvas-event:${item.sourceId}`,
  data: { type: 'canvas-entity', entityType: 'calendar_event', entityId: item.sourceId }
})
```

The draggable id is namespaced so it can never collide with a task id in
`DragProvider`'s selection lookup. Because the drag type is not a task type,
`DragProvider` renders no `DragOverlay` for it; the chip itself takes a
`CSS.Translate` transform while dragging so something follows the cursor. The
8px `PointerSensor` activation distance keeps click-to-open-popover intact.

## Testing

- `canvas-drop-entity.test.ts` — the mapping table (each accepted `type`, each
  rejected one), unknown/malformed payloads → `null`, multi-select expansion,
  single-drag fallback, pointer math including the keyboard-sensor `null` case.
- `canvas-card-overlay.test.tsx` — `useDndMonitor` mocked (precedent:
  `components/cold-zero-components.test.tsx`): a task drop creates a card at the
  drop point; a drag that resolves to no entity creates nothing; a drop whose
  `over` is a different droppable creates nothing; a multi-select drop creates
  one card per task and does not stack them.
- Calendar chip test — an event chip is draggable and carries the right payload;
  a task chip keeps its existing `type: 'calendar-task'` payload.
- Regression — dropping a task on the canvas must not also reschedule or move
  it: `use-drag-handlers`' `switch (overType)` must fall through with no side
  effect for the canvas droppable.

## Risks

1. A dnd-kit pointer drag passing over Excalidraw could start a selection
   marquee. The drag holds pointer capture on the source element, so Excalidraw
   should not see the moves — to be confirmed by hand in the running app.
2. Adding a drag to calendar event chips could disturb click-to-open-popover.
   Mitigated by the 8px activation distance and covered by a test.
3. Picker/drag disagreement on duplicates (accepted above).
