# Version History

A version is a saved copy of a note from an earlier moment: its whole text, kept on this device.
When a note loses text you wanted, by your own edit, a template, or another program writing to its
file, you can find the earlier text in version history and bring it back.

## Opening History

In a note, open the **⋯** menu at the top of the page and choose **Version history**. A journal
day has the same item in its menu. The list shows the note's versions, newest first, with the date,
time and word count of each.

## When a Version Is Made

Memry keeps a version of a note's text before something replaces it:

- when your edits add or remove 10 words or more since the file was last written,
- when you apply a template that changes the note,
- when you restore an older version (the text you had is kept first),
- when another program, an AI agent, or a sync from another device changes text that Memry is
  about to write over, however small the change,
- when another program changes a [locked note](./read-only-locks) and Memry puts the locked text
  back,
- when you quit Memry with the note open.

Memry does not keep the same text twice. If a version already holds it, that version moves to the
top of the list instead.

When an outside change arrives while you are typing, your typing wins and the outside text is kept
as a version. A message then says **"An outside change was replaced by your typing. It's saved in
version history."**, with a **Show versions** button that opens the list.

## Browsing Versions

Select a version to preview it. The preview is read-only and the note does not change. **Hide
Preview** and **Show Preview** toggle the preview pane.

## Restoring

Select a version and choose **Restore**, then confirm. The note's text is replaced with the
version's text.

Restoring never loses your current text. Memry keeps it as the newest version first, so you can
restore it again if you change your mind. If the note is open, the editor shows the restored text
in place; you don't need to close and reopen the note.

A [locked note](./read-only-locks) cannot be restored. Unlock it first.

## Deleting a Version

Select a version and choose the delete button, then confirm. Only that version is removed; the note
and its other versions stay.

## How Many Versions Are Kept

Each note keeps up to 50 versions. When a new version would make 51, the oldest one is removed.

## Versions Stay on This Device

Versions are stored in the vault's `.memry` folder on this device. They don't sync: another device
has its own version history for the same note.

## In the Tauri Desktop App

The desktop app built on Tauri, the replacement for the current Electron app, keeps versions by the
same rules, with these differences:

- **Restore changes only the text.** The note's properties and tags in its frontmatter stay as they
  are. The Electron app also put back the version's frontmatter.
- **Outside changes don't push out your own versions.** A version kept because another program
  changed the note only replaces other versions kept for text changes, never the versions kept when
  you quit Memry. A program that rewrites a note's file over and over cannot wipe out its history.
- **Text written while Memry saves is kept.** If another program writes to a note's file at the
  moment Memry saves it, Memry's text stays in the file and the other program's text is kept as a
  version. This works for vaults on a local disk on macOS and Linux, not on Windows or network
  drives.
