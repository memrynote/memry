# Organizing Canvases

Once you have more than a handful of boards, a flat list stops helping. The
**Canvases** sidebar section is a real tree: canvases sit in folders, folders
nest, and you move things between them by dragging or from a menu.

Folders are ordinary directories in your vault. A canvas in `Work/Q3` is the
file `canvases/Work/Q3/Plan.excalidraw`, so the tree in the sidebar and the
folders in your file manager are the same thing — make a folder either way and
it shows up in the other.

The `canvases` directory itself stays out of the **Collections** section. Your
boards live in one place in the sidebar — the **Canvases** section — so the note
tree never shows a second copy of the same tree.

## Creating folders

- **At the top level**, hover the **Canvases** section header and click the
  folder button (**New canvas folder**) beside the **+**.
- **Inside another folder**, right-click that folder — or focus it and use its
  **⋯** button — and choose **New folder**.

Either way the folder is created immediately, under a default name, and its row
in the tree turns into a text field with that name selected. Type the real name
and press <kbd>Enter</kbd>. <kbd>Esc</kbd> keeps the default name, and clicking
away accepts whatever you have typed.

Folders nest up to eight levels deep; anything that would go deeper is refused
rather than filed somewhere unexpected. A name the vault cannot accept — one
that is already taken, or too deep — leaves the field open with the reason
beside it, so you can type another one.

While the section is completely empty there is no row to right-click, so it
offers **New canvas** and **New folder** links directly. That is how the first
folder in a fresh vault gets made.

An empty folder is still a real folder. It reaches your other devices even
before you put anything in it, so you can set up a structure on one machine and
find it waiting on the next.

## Putting canvases in folders

- **New canvas here** — from a folder's menu. The new board opens in a tab, the
  folder expands to show it, and its row opens as a text field so you can name
  it without leaving the tree.
- **Drag a canvas** onto a folder row. The row outlines while it is a legal
  drop.
- **Drag a folder** onto another folder to move it, with everything inside.
- **Drag to the root** — the dashed strip under the last row is the way back
  out of a folder. It appears while you are dragging.

A move that would nest past the depth limit, or that would drop a folder into
its own subtree, simply refuses the drop.

## Doing all of it from the keyboard

Drag and drop has no keyboard path, so every placement action also lives in a
menu. Each row has a focusable **⋯** button holding the same items as its
right-click menu — including **Move to folder**, which lists every folder in the
tree plus **Root**. The folder a canvas is already in is greyed out.

Two shortcuts work directly on a focused row:

| Key                                      | Action                      |
| ---------------------------------------- | --------------------------- |
| <kbd>F2</kbd>                            | Rename the canvas or folder |
| <kbd>Delete</kbd> / <kbd>Backspace</kbd> | Delete, with a confirmation |

## Renaming

**Rename** from the row menu, or <kbd>F2</kbd>, turns the row itself into a text
field with the current name selected — there is no dialog, so the row never
moves out from under you.

- <kbd>Enter</kbd> commits the new name.
- <kbd>Esc</kbd> abandons the change and leaves the old name.
- Clicking away commits too; an empty or unchanged name is simply not written.

If the name is refused, the field stays open with the reason beside it and the
caret comes back to it, ready for another try.

Renaming a canvas renames its file too, so the board and the file keep the same
name. Renaming a folder moves the directory and everything inside it in one go —
the canvases keep their own names and follow the folder.

## Icons

Click the icon at the start of any row to open the picker and give a canvas or a
folder an emoji. The row menus also carry **Set icon** and, once one is set,
**Remove icon**. Folder icons sync along with the folder.

## Duplicating a canvas

**Duplicate** copies the board — ink, cards, images and icon — into the same
folder as the original, with a number appended to the name (`Plan` becomes
`Plan 2`). The copy is a separate canvas from that point on; editing one does not
touch the other.

A canvas whose file is missing or unreadable cannot be duplicated. Its row shows
a warning instead, and offers only **Reveal in Finder** and **Delete**.

## Finding a canvas

Once the section holds eight or more canvases, a filter box appears above the
tree. Type to narrow the tree to matching canvases and the folders that contain
them; <kbd>Esc</kbd> clears it. A query that matches nothing says so and keeps
the box on screen, so there is always something to clear.

A collapsed folder shows the number of canvases inside it, so you can see where
things are without opening everything. An expanded folder with nothing in it
says so, and offers a **New canvas here** link.

## Opening a canvas outside memrynote

Two items in a canvas row's menu leave the app:

- **Reveal in Finder** opens your file manager with the `.excalidraw` file
  selected.
- **Open in external editor** hands the file to whatever your system opens
  `.excalidraw` files with.

Both act on the real file in your vault. If you edit a canvas in another
application, memrynote picks the change up the next time it opens the vault.

## Deleting

**Delete** always asks first.

- Deleting a **canvas** removes it from memrynote and sends its file to this
  computer's trash.
- Deleting a **folder** takes everything inside it — the confirmation tells you
  how many canvases that is — and sends the whole directory to the trash.

Deletions sync, so a canvas you delete on one device disappears on the others.
On those other devices the file is removed outright; only the device you deleted
from keeps a copy in its trash.

That trash copy is a copy of the **file**, not an undo. Putting it back in your
vault does not bring the canvas back into memrynote: the delete is what every
device now agrees on, and a file reappearing must not overrule it — otherwise a
removal that failed on one machine would resurrect the canvas everywhere. To get
the drawing back, open the restored file in an Excalidraw editor and copy it into
a new canvas.

## Next steps

- [Cards & Links](./cards-and-links.md) — putting notes, tasks, and events on a canvas
- [Sync & Limits](./sync-and-limits.md) — how canvases and folders sync
