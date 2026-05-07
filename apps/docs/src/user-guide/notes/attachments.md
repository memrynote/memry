# Attachments

Drop files onto a note to attach them. PDFs preview inline; other types appear as download blocks.

<!-- screenshot: PDF preview block inside a note -->

## Adding Files

Two ways:

- **Drag and drop** — drop a file from your OS file manager onto the editor at the position you want it
- **Slash menu** — `/file` inserts a File block; click to pick a file

Files are **copied** into the vault attachments directory (`<vault>/attachments/`), so the original on your filesystem can be moved or deleted without breaking the note.

## File Block

Each attachment renders as a block with:

- The file name
- File size
- Type icon
- A download button
- A "Reveal in Finder" action (macOS)

## PDF Inline Preview

PDFs render in an embedded scrollable viewer right in the editor. Useful for reading PDF source material while taking notes.

The preview honors:

- Zoom (browser zoom or per-block scale)
- Find-in-page (the embedded viewer's find, not Memry's)
- Multi-page scrolling

## Image Attachments

Images render as image blocks (not file blocks). Drag them to resize; double-click for the lightbox.

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

## Garbage Collection

Files that are no longer referenced by any note are pruned during periodic vacuum. You don't need to clean them up manually.

## Sync Behavior

Attachment payloads sync as encrypted R2 blobs (the same path as note bodies). Large files don't block notes — sync interleaves uploads and prioritizes metadata.
