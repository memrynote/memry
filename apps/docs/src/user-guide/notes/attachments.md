# Attachments

Drop files onto a note to attach them. PDFs preview inline, audio files render with playback
controls, and other file types appear as download blocks.

<!-- screenshot: PDF preview block inside a note -->

## Adding Files

Three ways:

- **Drag from your OS file manager** — drop a file onto the editor at the position you want it. The file is **copied** into the vault attachments directory (`<vault>/attachments/`), so the original on your filesystem can be moved or deleted without breaking the note.
- **Drag from the sidebar** — drag a file item (PDF, image, audio, …) from the left sidebar onto a note. This **embeds it by reference** using the item's own vault path, so no second copy is made.
- **Slash menu** — `/file` inserts a File block; click to pick a file.

While you drag over a note, a line marks where the file will land, and dropping inserts it exactly there. The line follows the cursor once per frame instead of on every pointer event, so dragging over a long note stays smooth.

## File Block

Each attachment renders as a block with:

- The file name
- File size
- Type icon
- A download button
- A "Reveal in Finder" action (macOS)

## PDF Inline Preview

PDFs render inline as a clean first-page preview — no viewer chrome — so a note reads as a document with its source embedded. Open the file page (double-click the sidebar item) for the full multi-page viewer with zoom and find-in-page.

The file page viewer opens **fitted to the width of its pane**, so a document is readable straight away rather than at a fixed 100%. It keeps fitting as you resize the window or toggle the thumbnail sidebar — until you set a zoom yourself, after which your zoom is kept and restored with the tab. **Fit to width** puts it back. Fitting measures the real page, so A4 and landscape pages fit correctly too.

The viewer also has a thumbnail sidebar for jumping between pages. It draws only the thumbnails currently scrolled into view, so a several-hundred-page PDF opens without rendering every page up front.

The embed's controls sit on the preview itself. The resize corners are faintly visible at rest; hovering the preview, or clicking to select it, brings out the full set:

- **Resize** — drag either bottom corner. Width scales the whole embed like an image; dragging upward shortens it, cropping the first page from the top so only the opening shows (no inner scroll). The embed can be widened up to the note column.
- **Align** — the top-right toolbar aligns the embed **left**, **center**, or **right** within the note column.

Size, crop, and alignment are **saved with the note** and restored when you reopen it.

## Audio Attachments

Audio files render as inline audio blocks with playback controls. Filed voice memos keep their
transcript with the audio file, so opening the file page shows the player and transcript together.

The progress bar follows playback continuously, and only the scrubber and the time readout update
as the track plays — so leaving a long recording running in a background tab costs nothing beyond
the audio itself. Copying the transcript shows a checkmark for a couple of seconds; closing the
file page before it clears cancels it cleanly.

## Image Attachments

Images render as image blocks (not file blocks). Drag them to resize; double-click for the lightbox.

Inside a table cell an image is inline instead: a cell holds text-level content only, so
the image sits in the cell with a capped height. Pasting or dropping an image onto a cell
puts it there rather than below the table. See
[Images in a Table Cell](./editing.md#images-in-a-table-cell).

### Zooming and Panning

Opening an image as a file page gives you the full viewer: zoom in and out, reset to fit, and rotate
in 90° steps. Above 100% the image can be panned — drag it with the mouse and it tracks the cursor
one-for-one.

A pan keeps following your pointer even when it leaves the viewer or the app window, and ends
wherever you release the button, so you can drag a zoomed image right to its edge in one motion.
Zooming back out to 100% recenters the image.

The scroll wheel and the toolbar buttons zoom in different increments, but they agree on what
100% means: whenever the toolbar reads 100%, the image is recentred and the drag-to-pan hint is
gone, no matter which mix of wheel and buttons you took to get there.

### Images From Another App's Vault

Vaults written by Obsidian, Capacities and similar apps keep media in a shared
folder and reference it from notes with a relative path:

```markdown
![photo](../Images/Media/photo.png)
```

MemryNote resolves those paths against the note's own folder, so the images show
up as normal image blocks. Nothing is copied or rewritten — the markdown on disk
keeps its relative path, so the vault stays readable by the app that wrote it.

A path that points outside the vault is left alone rather than resolved, and so
are absolute paths (including Windows `\\server\share` style ones) and `http(s)`
URLs. If an image shows up broken, check that the referenced file actually sits
where the path points, relative to the note.

## Removing or Replacing

Click the file block menu to:

- **Delete** — removes the block from the note; the underlying file stays in the attachments dir until garbage collection
- **Replace** — swap the bound file without re-creating the block

## Storage

Attachments live in `<vault>/attachments/`. They are encrypted on sync — see [Cryptography](/architecture/cryptography).

Storage usage is visible in [Settings → Vault](/user-guide/settings#vault) with a stacked bar that breaks out:

- Notes (markdown / Yjs state)
- Attachments
- CRDT data
- Other (indexes, leveldb, caches)

### File Size Limits vs. Counted Storage

Your plan's per-file size limit applies to the **original file size**. Encryption overhead never counts against it, so a file that is exactly at your plan's limit still uploads.

Synced storage usage counts the **encrypted** size, which is a few bytes larger per chunk than the original (each chunk carries a nonce and an authentication tag). For a typical file this is a difference of tens of bytes.

If a file is over your plan's per-file limit, MemryNote tells you before it spends time encrypting it, and names the limit it hit. Freeing storage does not help in that case — the file itself is too big, so you need a plan with a larger per-file limit.

### When an Attachment Doesn't Sync

If an attachment can't be uploaded, you get a notification naming the file. The file is never lost: it stays in `<vault>/attachments/` and the note keeps working on this device. Only the synced copy is missing, so other devices won't see it until the upload succeeds.

When the upload fails because you're offline or the server is unreachable, MemryNote keeps retrying rather than giving up — being offline for a day is normal, and the queued upload is never discarded. Each retry waits a little longer than the last (one second, then two, four, and so on up to a minute) so a long offline stretch doesn't burn battery re-encrypting the file over and over. As soon as the network comes back, the wait is abandoned and everything queued is retried straight away.

## Garbage Collection

Files that are no longer referenced by any note are pruned during periodic vacuum. You don't need to clean them up manually.

## Sync Behavior

Attachment payloads sync as encrypted R2 blobs (the same path as note bodies). Large files don't block notes — sync interleaves uploads and prioritizes metadata.

### Transfer Progress

Transfers report progress as a whole percentage, updating only when that percentage changes rather than on every chunk — a large file moves through the same 0–100% either way, without flooding the interface.

Several attachments can upload and download at once, and each one tracks its own progress. One transfer finishing never stops another that is still running from reporting.

Every transfer ends, and the progress bar on the attachment ends with it. A transfer that succeeds clears its bar; a transfer that fails shows it briefly as failed and then clears too. So a bar that stays on an attachment means the transfer is genuinely still going — including a transfer that is only waiting for the network, which can sit quiet for a long time on a bad connection without being abandoned. If a transfer fails you still get the notification described in [When an attachment doesn't sync](#when-an-attachment-doesn-t-sync); the bar clearing is not a sign it worked.
