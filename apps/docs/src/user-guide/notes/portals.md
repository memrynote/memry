# Portals

A portal shows part of another note inside the note you are writing. It is live: edit the text in the portal and the source note changes, edit the source and the portal changes. Nothing is copied.

Use one when the same words belong in two places. A definition in your glossary can sit inside every lecture note that needs it, and there is only ever one copy to fix.

## Insert a portal

Type `((` or choose **Portal** from the `/` menu. A picker opens with two lists:

- **Blocks**: paragraphs, list items and other blocks that match what you type, each shown with its note and parent (`Lecture 1 › DNA`).
- **Notes**: whole notes.

Press <kbd>Enter</kbd> to insert the highlighted row. A block comes in **folded**: you see the block and none of its children. A note comes in whole.

Press <kbd>Cmd</kbd>+<kbd>Enter</kbd> (<kbd>Ctrl</kbd>+<kbd>Enter</kbd> on Windows and Linux) to take the **Create note** row instead. It makes a new note titled with what you typed and inserts a portal to it.

The picker never offers the line you are typing in, or any other line of the current note that still has an unfinished `((` in it, because a portal to itself would show nothing useful. It does offer other blocks of the same note.

### Copy as portal

To portal a block you are looking at, open its side menu (the handle at the left of the block) and choose **Copy as portal**. Paste into any note. The pasted portal is folded, like one from the picker.

Holding <kbd>Option</kbd> (<kbd>Alt</kbd>) while you drag a block into another note makes a portal instead of moving the block.

## What a portal shows

A portal shows a **folded** block, an **open** block, or a whole note.

- **Folded**: only the block. Its children are hidden. A row under it says how many (`3 hidden`).
- **Open**: the block and its children. Use the chevron next to a block to open or fold it.
- **Hidden**: a block you took out of this portal. The source note keeps it.

Edit freely inside a portal. Press <kbd>Enter</kbd> at the end of the last block and the new block stays visible in the portal. <kbd>Enter</kbd> on an empty last line moves the cursor out, to the next block of your note.

## Show more, show less

Click inside a portal and a small toolbar appears above it.

- **Path**: the toolbar shows where the block lives in its note. Click a name in the path to widen the portal to that parent. What you saw before stays visible under it.
- **Hidden count**: opens the list of blocks hidden from this portal, with their paths. Pick one to bring it back, or choose **Show all** (<kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>A</kbd>). The list has a search box once it is long.
- **More** (the three dots): **Open beside** (the source note in a split), **Copy contents** (the visible text as Markdown), **Copy link**, and **Remove portal**.

To hide a block from one portal, put the cursor in it and press <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>H</kbd> (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>H</kbd> on Windows and Linux), or use **Hide in this portal** in its side menu. This only changes the portal. A portal keeps at least one block, so the last one cannot be hidden: remove the portal instead.

## Where a block is used

A block that is shown in other notes gets a small count. Click it to see **Portals** and **Links** that point at the block, and open any of them. Portals and links inside the same note are not counted.

Deleting a block that other notes show asks first. You can delete it everywhere, or, from inside a portal, hide it there instead.

## When the source is not available

A portal that cannot show its source says so in one line instead of going blank:

- The source note was deleted. The reference stays until you remove it.
- The block was deleted in the source note. Pick another block, or remove the portal.
- The source note has not synced to this device yet. Try again once sync catches up.
- The portal leads back to itself, or nests more than three levels deep. It opens as a link to the source.

A locked note shows read only in a portal. See [Read-Only Locks](/user-guide/notes/read-only-locks).

## In the file

A portal is saved in the note as a code fence tagged `memry-portal` that holds a short JSON definition: the source note and the blocks you chose. Each portaled block carries a small hidden `^id` at the end of its text so the portal can find it again after the block moves. Notes with portals open in older versions as that code block.
