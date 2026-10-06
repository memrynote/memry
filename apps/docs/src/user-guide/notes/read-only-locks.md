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

A locked note opens read-only. A small lock line above the title says so, and the body, title,
tags, and properties cannot be changed.

Everything that would change a locked note is refused:

- typing in the editor, applying a template, restoring an older version,
- renaming, moving, or deleting it, or the folder it sits in,
- creating, renaming, or deleting anything inside a locked folder,
- every AI agent write: the note and folder tools, `vault_desktop_write`, and HTML artifacts.
  The agent is told **"The owner made this note read-only."** "Always allow" approvals do not
  change this.

Vault-wide changes such as renaming a tag or updating links after a rename skip locked notes and
carry on with the rest.

## Other Devices

Locks sync with your other devices. Edits made to a locked note on a device that does not know
the lock yet, for example one running an older version of Memry, still arrive. The lock stops
changes made on this device; it does not throw away changes that come in through sync.

## Edits From Outside Memry

Memry also marks every locked file read-only on disk, so most editors and command-line tools
refuse to save over it.

If a locked file is changed or deleted anyway, Memry keeps the changed text as a version in the
note's [version history](./version-history), writes the locked text back, and tells you which note
it restored. This also happens at the next start when the change was made while Memry was closed.
