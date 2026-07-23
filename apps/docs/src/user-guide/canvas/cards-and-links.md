# Cards & Links

A **card** is a live reference to a note, task, or calendar event placed on a
canvas. The canvas stores the reference, never a copy of your content.

## Adding cards

- **Drag a note** from the sidebar onto the canvas.
- **Click "Add card"** at the bottom of the canvas to search your notes, tasks
  and events, or to create a new note without leaving the board. "Create
  note …" is always the first option, and typing a title carries it into the
  new note. The picker opens over a dimmed canvas; press <kbd>Esc</kbd> or
  click outside it to go back to the board.

Task and calendar-event cards are added through **Add card**. Dragging works
for notes from the sidebar; the Tasks and Calendar pages have no drag-in, so
tasks and events always go through the picker.

Files you have filed into your vault — PDFs, images, audio and video — do not
appear in the picker. A note card renders a markdown preview, so those open in
the file viewer instead. They never take up room in the search results, so a
matching note is always shown even when many filed files share its name.

Results are grouped into Notes, Tasks and Events, and each row is labelled the
way the rest of the app labels it, so you can tell at a glance what you are
about to place:

- **Notes** show the note's own icon, its folder path and when it was created.
- **Tasks** show a checkmark when they are done, plus their project, status,
  priority and due date.
- **Events** show a clock and the event's date and time.

If you pick something that is already on the board, Memry scrolls to the card
you already have instead of adding a duplicate — look for the **On canvas**
badge in the results.

A card added from the picker lands in the middle of your view, or in the
nearest free spot beside it when something is already there. Add three tasks
and an event in a row and they tile out from the centre instead of piling up on
one point.

Cards show a live preview: a note's title and the start of its body, a task's
title and status, an event's title and time. Rename or complete the item
anywhere in the app and the card updates.

If the underlying item is deleted, the card stays but is marked as deleted, so
you never lose the spatial context.

## Editing on the canvas

**Double-click a card** to edit it in place — the full note editor, the task
fields, or the event form, right on the board. Click anywhere else, or press
**Escape**, to go back to the preview.

Only one card is editable at a time. That is deliberate: it keeps large boards
responsive.

### When a note card stays read-only

If a note card shows **Open in tab to edit**, in-place editing is unavailable
for it right now. That happens when the same note is already open in another
visible pane, or is already being edited on another canvas card.

Editing the same note in two places at once, on a device without an active,
authenticated sync session, would let the two editors overwrite each other's
text. Rather than risk losing what you typed, the card stays a read-only
preview and points you at the surface that owns the edit. Click **Open in tab
to edit** to jump there.

On a device with an active sync session, both surfaces share a single live
document, so this does not apply and you can edit in either place. This
read-only fallback applies to note cards only — task and event cards always
edit in place.

## Opening an item in a tab

Every card has an **↗ Open in tab** button. It opens a note in a note tab, a
task in the Tasks page with its detail drawer, and an event focused in the
Calendar.

Double-click edits in place; ↗ opens a tab. The two never trigger each other.

## Connecting cards

Draw an arrow from one card to another and it binds to both. Move a card and the
arrow follows. Links are saved with the canvas.

Canvas arrows are visual: they do not create wiki links or backlinks between the
underlying notes.
