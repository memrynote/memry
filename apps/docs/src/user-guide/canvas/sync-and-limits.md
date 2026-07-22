# Canvas Sync & Limits

## How canvases sync

With sync enabled, canvases sync across your devices end-to-end encrypted, like
your notes. The server stores only ciphertext and never sees your board.

Cards sync as references. The notes, tasks, and events they point at sync
through their own channels, so a card on device B resolves to the same item.

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

## Size limit

A canvas has a maximum synced size (the raw drawing data, not counting
externalized images). A board that grows past it is still saved on your
device, but stops syncing until it gets smaller, and memrynote tells you so
rather than failing silently. Splitting a very large board into several
canvases is the usual fix.

## Known limitations

- Real-time co-editing of one canvas is not supported (see conflict copies).
- Canvas arrows do not create backlinks between notes.
- Adding a task or calendar-event card requires the note-drag or New note
  entry points described in [Cards & Links](./cards-and-links.md) — there is no
  drag-in from the Tasks or Calendar pages yet.
- Palm rejection and pen pressure depend on your hardware and OS.
- The drawing toolbar's language comes from the underlying canvas engine and may
  differ from memrynote's interface language.
- Canvas is opt-in per device — enabling it on one device does not enable it on
  another.
