# Read-Only Locks

Lock a note, or a folder and everything in it, when it should stay exactly as it is: a signed
contract, a finished report, reference material you hand to an AI agent but never want it to edit.

## Locking and Unlocking

Right-click a note or a folder in the sidebar and choose **Lock note** or **Lock folder**. Choose
**Unlock note** or **Unlock folder** to undo it. Inside an open note, the same toggle sits in the
**⋯** menu at the top of the page.

A folder lock covers every note and subfolder in it, including notes added to it later from
another device. A note inside a locked folder is unlocked by unlocking the folder.

## What a Lock Does

A locked note opens read-only wherever it is shown: its own page, a canvas card, and a project's
overview. A small lock line above it says so, and the body, title, tags, properties, and suggested
tags cannot be changed.

Everything that would change a locked note is refused:

- typing in the editor, applying a template, restoring an older version,
- turning **Set local only** or **Disable local only** on the note,
- renaming, moving, or deleting it, or the folder it sits in,
- creating, renaming, or deleting anything inside a locked folder, including importing files
  into it or filing an inbox item into it or onto a locked note,
- every AI agent write: the note and folder tools, `vault_desktop_write`, and HTML artifacts.
  The agent is told **"The owner made this note read-only."**, for a locked folder too. "Always
  allow" approvals do not change this.

Vault-wide changes such as renaming, merging, or deleting a tag, or updating links after a
rename, skip locked notes and carry on with the rest.

Canvases cannot be locked. They live in a folder that does not appear in the sidebar.

## Other Devices

Locks sync with your other devices. Edits made to a locked note on a device that does not know
the lock yet, for example one running an older version of Memry, still arrive. The lock stops
changes made on this device; it does not throw away changes that come in through sync.

When your sync server does not know locks yet, the lock stays on this device and the rest of
your changes keep syncing. Memry sends the lock again once the server is updated.

## Edits From Outside Memry

Memry also marks every locked file read-only on disk, so most editors and command-line tools
refuse to save over it.

If a locked file is changed or deleted anyway, Memry keeps the changed text as a version in the
note's [version history](./version-history), writes the locked text back, and tells you which note
it restored. This also happens at the next start when the change was made while Memry was closed.

## Going Back to an Older Version of Memry

A version of Memry without locks ignores them, but locked files stay read-only on disk. To edit
one of them there, unlock it in a current version first, or give yourself write access again: on
macOS or Linux run `chmod u+w` on the file, on Windows uncheck **Read-only** in the file's
**Properties**.
