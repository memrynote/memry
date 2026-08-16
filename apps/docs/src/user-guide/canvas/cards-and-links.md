# Cards & Links

A **card** is a live reference to a note, task, or calendar event placed on a
canvas. The canvas stores the reference, never a copy of your content.

## Adding cards

- **Drag the item onto the canvas.** Notes from the sidebar, tasks from any
  task list, and events from the Calendar all drop straight onto the board and
  become a card where you let go. A dashed outline shows the canvas is ready to
  take the drop.
- **Click "Add card"** at the bottom of the canvas to search your notes, tasks
  and events, or to create a new note without leaving the board. "Create
  note …" is always the first option, and typing a title carries it into the
  new note. The picker opens over a dimmed canvas; press <kbd>Esc</kbd> or
  click outside it to go back to the board.

Searching is never required. If you can see the item — in the sidebar, in the
other half of a split view, on the Calendar — you can drag it over.

### Dragging items in

Tasks drag from anywhere they are listed: the Tasks page, a board column, a
project, and Today. Select several tasks first and the whole selection drops
together, tiled side by side rather than stacked on one point.

Calendar events drag from the day, week and month views. Dragging an event onto
a canvas never changes its date — it only places a card.

Inbox items cannot be dragged onto a canvas. File one first: the note or task
it becomes can then be dragged over like any other item.

Dropping something that already has a card gives you a second card for it. Both
stay live and both update together — useful when the same note belongs to two
clusters on the board. The **Add card** picker behaves differently: pick
something that is already on the board and it scrolls to the card you have
instead, marked with an **On canvas** badge.

Files you have filed into your vault — PDFs, images, audio and video — do not
appear in the picker. A note card renders your note's own content, so those
open in the file viewer instead. They never take up room in the search results, so a
matching note is always shown even when many filed files share its name.

Results are grouped into Notes, Tasks and Events, and each row is labelled the
way the rest of the app labels it, so you can tell at a glance what you are
about to place:

- **Notes** show the note's own icon, its folder path and when it was created.
- **Tasks** show a checkmark when they are done, plus their project, status,
  priority and due date.
- **Events** show a clock and the event's date and time.

A card added from the picker lands in the middle of your view, or in the
nearest free spot beside it when something is already there. Add three tasks
and an event in a row and they tile out from the centre instead of piling up on
one point.

## Removing cards

Select a card and press <kbd>Backspace</kbd> to take it off the board. Only the
card goes — the note, task or event itself is untouched and stays wherever it
lives.

Cards render their item exactly as the editor does — a note shows its real
formatting (headings, lists, checkboxes, linked task blocks, images, callouts
and embeds), a task its fields, an event its details. Nothing is flattened to a
plain-text preview, so an inline task or a heading looks the same on the board
as it does in the note. Rename or complete the item anywhere in the app and the
card updates.

A note card is sized to its own content: a short note stays compact, while a
longer one grows to a readable height and scrolls inside its frame.

If the underlying item is deleted, the card stays but is marked as deleted, so
you never lose the spatial context.

## Editing on the canvas

**Double-click a card** to edit it in place — the full note editor, the task
fields, or the event form, right on the board. The card does not change shape
or size when you do: it is already the real editor, and the double-click only
makes it writable. Click anywhere else, or press **Escape**, to make it
read-only again.

Only one card is editable at a time. That is deliberate: it keeps large boards
responsive.

### When a note card stays read-only

If a note card shows **Open in tab to edit**, in-place editing is unavailable
for it right now. That happens when the same note is already open in another
visible pane, or is already being edited on another canvas card.

Editing one note in two places at once is only safe when both surfaces are
backed by the same live document. An active, authenticated sync session is the
signal Memry uses to be sure of that — so without one it will not take the
chance that two editors end up overwriting each other's text. The card stays a
read-only preview and points you at the surface that owns the edit. Click
**Open in tab to edit** to jump there.

On a device with an active sync session, both surfaces are known to share a
single live document, so this does not apply and you can edit in either place.
This read-only fallback applies to note cards only — task and event cards
always edit in place.

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
