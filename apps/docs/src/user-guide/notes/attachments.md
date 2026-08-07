# Attachments

Drop files onto a note to attach them. PDFs preview inline, audio files render with playback
controls, and other file types appear as download blocks.

<!-- screenshot: PDF preview block inside a note -->

## Adding Files

Three ways:

- **Drag from your OS file manager** — drop a file onto the editor at the position you want it. The file is **copied** into the vault attachments directory (`<vault>/attachments/`), so the original on your filesystem can be moved or deleted without breaking the note.
- **Drag from the sidebar** — drag a file item (PDF, image, audio, …) from the left sidebar onto a note. This **embeds it by reference** using the item's own vault path, so no second copy is made.
- **Slash menu** — `/file` inserts a File block; click to pick a file.

## File Block

Each attachment renders as a block with:

- The file name
- File size
- Type icon
- A download button
- A "Reveal in Finder" action (macOS)

## PDF Inline Preview

PDFs render inline as a clean first-page preview — no viewer chrome — so a note reads as a document with its source embedded. Open the file page (double-click the sidebar item) for the full multi-page viewer with zoom and find-in-page.

The file page viewer has a thumbnail sidebar for jumping between pages. It draws only the thumbnails currently scrolled into view, so a several-hundred-page PDF opens without rendering every page up front.

Hover the preview, or click to select it, to reveal its controls:

- **Resize** — drag either bottom corner. Width scales the whole embed like an image; dragging upward shortens it, cropping the first page from the top so only the opening shows (no inner scroll).
- **Align** — the top-right toolbar aligns the embed **left**, **center**, or **right** within the note column.

Size, crop, and alignment are **saved with the note** and restored when you reopen it.

## Audio Attachments

Audio files render as inline audio blocks with playback controls. Filed voice memos keep their
transcript with the audio file, so opening the file page shows the player and transcript together.

## Image Attachments

Images render as image blocks (not file blocks). Drag them to resize; double-click for the lightbox.

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

## Garbage Collection

Files that are no longer referenced by any note are pruned during periodic vacuum. You don't need to clean them up manually.

## Sync Behavior

Attachment payloads sync as encrypted R2 blobs (the same path as note bodies). Large files don't block notes — sync interleaves uploads and prioritizes metadata.
