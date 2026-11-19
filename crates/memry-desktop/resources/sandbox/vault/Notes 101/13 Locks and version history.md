---
tags:
  - notes-101
level: Advanced
summary: 'Read-only locks, version history, restoring and local-only notes'
---
Two ways to make a note safe: stop it changing, or be able to go back.

## Read-only locks

Lock a note, or a whole folder, when it should stay exactly as it is: a signed contract, a finished spec, reference material for an AI agent. **Insert:** right-click a note or folder in the sidebar and choose **Lock note** or **Lock folder**, or use the lock item in the note's **...** menu.

[[Typography spec (signed off)]] is locked in this vault. Open it: a line above the text says it is read-only, and the title, tags, properties and body cannot change. The lock also stops renames, moves, deletes, template applies, restoring a version, and every AI write. Unlock it from the same menu.

A folder lock covers every note in it, including ones that arrive later. Locks sync, though a change made on a device that does not know the lock yet still arrives.

## Version history

Memry saves versions of a note while you write: after a pause, before big automated changes, and now and then in a long session. Open **Version history** from the note's **...** menu to see the timeline. Select a version to preview it, switch on the diff to see what changed, and **Restore** to bring it back. Restoring is not destructive: the current text is saved as a new version first.

[[Space race essay draft]] has several saved drafts, so its history has something to show. Versions are kept on this device and thin out with age: dense for the last day, sparse for the last month.

## Local only

**Set local only** (note menu) keeps a note on this device. It is never uploaded, and everything written while it is local stays put. Locked notes cannot be switched.

Nothing in this vault syncs anyway; more on that in [[Sync and privacy]].

Back to the start: [[00 What a note is]].
