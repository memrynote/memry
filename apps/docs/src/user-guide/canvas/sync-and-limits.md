# Canvas Sync & Limits

## How canvases sync

With sync enabled, canvases sync across your devices end-to-end encrypted, like
your notes. The server stores only ciphertext and never sees your board.

Cards sync as references. The notes, tasks, and events they point at sync
through their own channels, so a card on device B resolves to the same item.

Folders sync too, including their icons and including folders with nothing in
them, so the structure you build on one device is the structure you find on the
next. See [Organizing Canvases](./organizing.md). Folder support arrived with a
server update — if a device is running an older release of memrynote, canvases
still reach it, but they arrive at the top level until it is updated.

## Conflict copies

Canvases are not real-time collaborative documents. If the same canvas is edited
on two devices before they sync, memrynote keeps one version as the canvas and
saves the other as a **conflict copy** — a second canvas in your sidebar.

Nothing is discarded. You open both and merge them by hand.

This is why editing one board simultaneously on two devices is best avoided;
editing different boards, or the same board at different times, is fine.

## Images and other assets

Images pasted or dropped onto a canvas are stored as attachments rather than
inside the board itself, so boards stay small and an identical image used twice
is stored once. Deleting the image, or the canvas, releases the stored copy.

Moving an image out of the board needs sync. While you are signed out, or while
sync is not running, the image simply stays inside the board: the canvas still
saves and you keep drawing, and memrynote moves the image out on a later save,
once sync is available again. Boards edited that way are larger than usual in
the meantime, so they can reach the size limit below sooner.

## The shape library

Your shape library is a single `library.excalidrawlib` file in your vault's
`canvases/` folder, alongside your boards, and is shared by every canvas. It does
not yet sync between devices: a kit you install on one computer stays on that
computer, and you install it again on the next one. Installing different kits on
two devices is safe — neither replaces the other.

## Size limit

A canvas has a maximum synced size (the raw drawing data, not counting
externalized images). A board that grows past it is still saved on your
device, but stops syncing until it gets smaller, and memrynote tells you so
rather than failing silently. Splitting a very large board into several
canvases is the usual fix.

The warning appears once, when the board crosses the limit — not again on every
edit while you keep working, and not again each time you switch to another tab
and come back. It comes back when there is something new to say: after a save
that synced is followed by one that is too large again, or the next time you
start memrynote and the board is still too large.

## Known limitations

- Real-time co-editing of one canvas is not supported (see conflict copies).
- Canvas arrows do not create backlinks between notes.
- There is no drag-in from the Tasks or Calendar pages — use **Add card**, as
  described in [Cards & Links](./cards-and-links.md).
- Filed PDFs, images, and other binaries don't show up as note results in the
  **Add card** picker — only markdown notes are searchable there.
- Palm rejection and pen pressure depend on your hardware and OS.
- The drawing toolbar's language comes from the underlying canvas engine and may
  differ from memrynote's interface language.
- The Canvas toggle is per device — turning it off on one device does not turn
  it off on another.
- The shape library is stored per vault but does not sync between devices yet.
- Publishing a shape kit to the public Excalidraw library from inside memrynote
  is not supported; the panel's **Publish** action does not work here.
