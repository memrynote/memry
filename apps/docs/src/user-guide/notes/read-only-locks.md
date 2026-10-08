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

Journal entries follow the folder they are saved in. When you lock the journal folder (it appears in
the sidebar when the journal setting **Show in sidebar** is on) or a folder above it, every journal day
opens read-only with the same lock line, including days that have no entry yet.

A single journal entry cannot be locked from the menu. To lock an entry, lock its folder.

Everything that would change a locked note is refused:

- typing in the editor, applying a template, restoring an older version,
- turning **Set local only** or **Disable local only** on the note,
- adding, renaming, or deleting its attachments, including setting a cover image,
- renaming, moving, or deleting it, or the folder it sits in,
- creating, renaming, or deleting anything inside a locked folder, including importing files
  into it or filing an inbox item into it or onto a locked note,
- every AI agent write: the note and folder tools, `vault_desktop_write`, and HTML artifacts.
  The agent is told **"The owner made this note read-only."**, for a locked folder too. "Always
  allow" approvals do not change this.

Vault-wide changes such as renaming, merging, or deleting a tag, or updating links after a
rename, skip locked notes and carry on with the rest.

Changing the journal **Date format** renames every journal file, so it is refused as a whole
when any journal entry it would rename is locked, or a rename would move one into a locked
folder. Settings shows **"The owner made this note read-only."**, the old format stays, and no
file is renamed. Unlock the folder, then change the format again.

Canvases cannot be locked. They live in a folder that does not appear in the sidebar.

## Other Devices

Locks sync with your other devices. Edits made to a locked note on a device that does not know
the lock yet, for example one running an older version of Memry, still arrive. The lock stops
changes made on this device; it does not throw away changes that come in through sync.

When your sync server does not know locks yet, the lock stays on this device and the rest of
your changes keep syncing. Memry sends the lock again once the server is updated.

A folder lock is stored by the folder's path. Renaming a locked folder is refused here, but a
device running an older version of Memry can still rename it. The lock then stays on the old
path and no longer covers the renamed folder. Lock the folder again under its new name.

## Edits From Outside Memry

Memry also marks the file of every locked note read-only on disk, together with the files in its
attachments folder, so most editors and command-line tools refuse to save over them. A file moved
into a locked folder, a locked note renamed, and a locked file replaced from outside Memry are
read-only again as soon as Memry sees the change. Unlocking gives each file back the permissions
it had before the lock.

If a locked markdown note is changed or deleted anyway, Memry keeps the changed text as a version
in the note's [version history](./version-history), writes the locked text back, and tells you which
note it restored. This also happens at the next start when the change was made while Memry was
closed.

A lock does not cover everything outside the app:

- Renaming or moving a locked note's file outside Memry, for example in Finder or with `mv`, is
  not reverted. The file stays read-only, and the rename or move syncs to your other devices.
- Only markdown notes are written back. A locked PDF, image, or other file that is deleted
  outside Memry is not restored, and the delete syncs.
- Read-only on disk does not stop every program. Some can still delete or replace a locked
  attachment, and Memry does not restore it.

## Going Back to an Older Version of Memry

A version of Memry without locks ignores them, but locked files stay read-only on disk. To edit
one of them there, unlock it in a current version first, or give yourself write access again: on
macOS or Linux run `chmod u+w` on the file, on Windows uncheck **Read-only** in the file's
**Properties**.
