# Canvas Overview

A canvas is an infinite, freeform board. You draw on it, and you place real
notes, tasks, and calendar events on it as cards. Nothing on a canvas is a copy:
a card points at the actual item, so editing it anywhere updates it everywhere.

Canvases are useful when an outline is the wrong shape for your thinking —
planning a project, mapping how ideas connect, sketching a diagram next to the
notes it explains.

## Turning it on and off

Canvas is on by default: a **Canvases** section is already in your sidebar.

Canvas was off by default in earlier versions, so upgrading turns it on once
even if it was off before. Turning it off after that keeps it off for good.

To hide it, open **Settings → Features** and turn **Canvas** off. The setting is
per device and persists across restarts, so turning it off on your laptop leaves
it on elsewhere. Turning it off hides the surface — it does not delete any
canvas you have already made.

## Creating and opening a canvas

- Hover the **Canvases** sidebar section and click the **+** button (**New
  canvas**) that appears.
- Click any canvas in the sidebar to open it in a tab, like a note.
- Canvases open in the normal tab system, so you can split the view and keep a
  canvas beside a note. See [Tabs & Split View](../tabs-split-view.md).

## Drawing

The canvas uses a full drawing surface: freehand ink, shapes, arrows, text,
colors, multi-select, grouping, and undo/redo. A pen or stylus with pressure
support draws variable-width strokes where the hardware and OS report pressure.

Palm rejection depends on your operating system and hardware rather than on
memrynote, so resting your hand on a touchscreen while drawing may still
register. Test it on your own device before relying on it.

The drawing toolbar is provided by the underlying canvas engine and follows its
own language list, which does not always match memrynote's interface language.

## Shape library

The library is the panel of reusable shapes you can drag onto any board. Open it
with <kbd>0</kbd> or the library button in the toolbar.

To install a shape kit, download an `.excalidrawlib` file — for example from
[libraries.excalidraw.com](https://libraries.excalidraw.com) — and add it either
way:

- **Drag the file** onto the canvas.
- **Open the library panel**, click the **⋯** menu, and choose **Open**.

Your library is a single `library.excalidrawlib` file in your vault's `canvases/`
folder, in Excalidraw's own format, and is shared by every canvas rather than
belonging to one board — so a kit you install stays available when you switch
boards or restart. Removing an item from the panel removes it for good.

## Saving

Canvases save into your vault automatically as you draw — there is nothing to
save by hand. Pressing **Cmd/Ctrl+S** simply confirms this with a short
"changes are saved" notice; it never opens a file dialog.

Each canvas is a plain `.excalidraw` file in your vault's `canvases/` folder,
named after the board's title. The file is the real canvas and the sidebar entry
is an index of it, so copying that folder to another machine brings the boards
along, and dropping an `.excalidraw` file into `canvases/` adds it as a canvas
the next time memrynote opens the vault. Renaming a file outside the app doesn't
create a duplicate either — the same board picks up the new filename on the next
open, though its title in the sidebar stays as it was.

Because your vault is the only store, the drawing engine's own **Open** and
**Save to...** actions are hidden for _boards_: they would write a copy outside
the vault, or silently replace the canvas you have open, instead of editing the
file the app is already saving to. **Export image...** stays available for taking
a PNG or SVG copy, and so do the library's own file actions, since a shape kit is
a file you bring in from elsewhere.

## Next steps

- [Cards & Links](./cards-and-links.md) — putting notes, tasks, and events on a canvas
- [Sync & Limits](./sync-and-limits.md) — how canvases sync, and what to watch out for
