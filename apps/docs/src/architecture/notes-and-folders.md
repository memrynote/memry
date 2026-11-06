# Notes and Folders (Tauri)

How the Tauri app (`apps/desktop-tauri`) creates, edits, renames, moves and deletes notes, folders and journal days. The services are in `crates/memry-desktop/src/notes/`, `journal/`, `templates/` and `tags/`, and the Tauri commands that call them are in `apps/desktop-tauri/src-tauri/src/commands/`. This page builds on [Vault Files (Tauri)](/architecture/vault-files), which covers the watcher, the consumer and the write-back. The Electron app does the same work in `apps/desktop/src/main/vault/`, described in [Local Storage](/architecture/local-storage).

## The problem

A note is three things that must agree:

| Part     | Where                                         | Holds                                                                            |
| -------- | --------------------------------------------- | -------------------------------------------------------------------------------- |
| Record   | `sync_items` and its projections in `data.db` | The id, title, folder, tags, properties and icon. Syncs to every device.         |
| File row | `note_files` in `data.db`                     | The vault-relative path, the size and the content hash. Never leaves the device. |
| File     | `<vault>/<folder>/<title>.md`                 | The text, which you and other programs can change at any time.                   |

An operation in the app changes all three, one after another. Between two steps the watcher can report the file, the write-back can write it, and the app can crash.

For example, you rename `Plan` to `Roadmap`. The watcher sees `Plan.md` go and `Roadmap.md` appear. If it reports that before the record and the row follow, the note is deleted and a new note is made, on every device.

Four rules keep the parts in step:

- **One write of a note at a time.** `WriteOrder` (`notes/write_order.rs`) runs the app's writes of one note in the order they arrived. Writes of different notes do not wait for each other.
- **The rows' lane.** An operation holds the vault tier's lane from its first check to its last row write. The watcher's facts and the write-back's passes go through the same lane, so none of them lands in between.
- **The own-write record first.** Before the app writes, moves or removes a file, it tells the tier's own-write record (`EchoGuard`). The watcher then never reports the app's own change as an outside edit, delete or new file.
- **A crash leaves a known state.** Each operation orders its steps so that a crash between any two leaves something the next open finishes, or something you can see and act on. Each module doc lists those states.

## Which note a file is

`notes/identity.rs` answers which note or journal day a vault file is. The rules are in the core, in `memry_core::domain::notes::{identity, journal_day}`.

- A markdown file is a note titled by its file name without `.md`, in the folder it is in. The frontmatter holds no id.
- A file whose path names a day in the journal folder, in the vault's journal date format, is that day's entry. Its id is `j<YYYY-MM-DD>` on every device.
- A markdown file in the large-file class (over 1 MiB, or a block over 128 KiB) gets no note. Electron lists it as a read-only note. The Tauri app does not list it until the large-file viewer is ported (Step 14, #3531).
- When the identity cannot tell, it answers `Defer` and asks again at the next open. It never creates or deletes a note on a guess.
- A removed file deletes its note only when the file row proves the file held the whole note: the document took the row's bytes and nothing came after. Otherwise the note stays and the log warns, because a tombstone would delete on every device text the file never had.
- An outside edit of a file gives the record the file's frontmatter `tags` (for a journal day, only the tags the edit changed).
- A move that changes what a file is (a note moved to a day's path, or a day moved out of the journal folder) deletes the record, and the file is made anew as the other kind. The watcher does this when it sees the move. A move the app makes, or one the identity could not settle, waits for the next open's walk (`notes/owed_moves.rs`).

The core tables are additive migrations of `data.db`: `note_files` (`0015_note_files.sql`), `note_file_hashes` (`0017`), `note_place_owed` (`0018_note_identity.sql`) and `wiki_name_keys` (`0019`). The sidebar's manual order is `note_positions` (`0016_notes_device_tables.sql`). All of them stay on the device.

## Create, delete, rename and move

Every operation is a method of `NotesService` (`notes/service.rs`). The shell calls it on a blocking thread.

### Create

`notes/create.rs`, after Electron's `createNote`:

1. Pick the path: the title's file name in the folder, or in the vault's default note folder. When a note or a file already has the name, the next free `<name> N.md` is used.
2. Write the record, with its tags, properties and icon.
3. Write the file row, with no hash yet.
4. Write the file. A file that appeared at the path in the meantime is never replaced.
5. Seed the note's document from the file, then store the row's hashes.

The row comes before the file for a reason. A file with no row is offered to the identity, which matches a row-less note only by folder and title. After a crash, `Plan 1.md` would not match the title `Plan`, and the file would become a second note.

A template is read first. The one the caller names wins, then the one a tag names, then the one the folder's `.folder.md` gives (see [Templates](#templates)).

### Delete

`notes/delete.rs`, after Electron's `deleteNote`:

1. Remove the file. When its bytes are the ones the document holds, it is removed for good. Any other file holds text the note never read, so it goes to the OS trash. When the trash refuses (a Linux mount with no usable `.Trash-<uid>`), the delete fails with `note_trash_unavailable` and the note stays whole. When you then confirm a permanent delete, the app tries the trash again and unlinks the file only if the trash still refuses (#3813).
2. Tombstone the record, so every other device deletes the note. A [local-only note](#local-only-notes) sends no tombstone.
3. Remove the row and the note's slot in the sidebar order.

### Rename and move

`notes/moves.rs`, after Electron's `renameNote` and `moveNote`. A rename gives the note a new title and its file the matching name. A move puts the file in another folder. The bytes stay as they are.

1. Pick the target: the first free `<name>.md`, `<name> 1.md`, and so on. The note's own file under another spelling counts as free, so a rename that changes only case respells the file in place.
2. Record the move in the core, then move the file without replacing anything.
3. Update the record, the row and the sidebar slot in one core transaction, which also forgets the recorded move.
4. In later write turns, re-point the moved note's own relative embeds from its new folder, and rewrite the links to the note in other notes (see [Links follow a rename](#links-follow-a-rename)).

When step 3 fails, the file moves back. When the app crashes between steps 2 and 3, the next open finishes the move before the watcher starts (`vault/app_move.rs`, `finish_interrupted`). Step 4 has no durable record: a crash there leaves the links stale, as in Electron. A replayed record is #3886.

### Editor save

`notes/update.rs` handles the editor's save of a note's body, header tags and icon. It goes through the app-edit seam below with `Precondition::Save`. The record takes the icon and the tags only once the file holds them, so a refused write leaves the record as the file says.

## The app-edit seam

`vault/app_edit.rs` is the one owner of "the app changes the text of an existing note file, and the note's document follows". The editor save, the link rewrite, the property writer, the linked mention, a note's other names (aliases), a template's apply and a tag's template all call it. Nothing else composes the own-write record, the file write and the document feed by hand.

The caller passes a precondition that says what the edit may replace:

| Precondition | Replaces                                                                                 | Used by                                                              |
| ------------ | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `Held`       | Only a file whose bytes the document holds. Anything else is `Kept` and nothing changes. | Link rewrite, linked mention, aliases, property values, tag template |
| `HeldAt`     | `Held`, for a note whose file moved since its document read it                           | A moved note's own relative embeds                                   |
| `Replace`    | `Held`, and keeps a version of the whole file first                                      | Applying a template                                                  |
| `Save`       | Whatever is there, keeping a version of a file the app did not write                     | The editor save, a journal day's save                                |

A `Kept` answer names why: an outside edit not fed yet (`FileChanged`, `NotRead`), a document ahead of its file (`BodyAhead`), a body not pulled yet, or a frontmatter that does not parse. Callers turn it into an error you can act on, or skip the note and log it.

The seam feeds the document first, then writes the file, then the row. In this order, an outside edit that lands during the write makes the write refuse. The document already holds the app's edit, and the consumer then feeds the outside edit over it and keeps the app's edit as a version, so neither is lost. In the other order the outside edit would be lost. The module doc has the full trace of each crash point.

## Links follow a rename

When a note is renamed or moved, `notes/link_rewrite.rs` rewrites every `[[Old]]`, `[[Old#Heading|alias]]` and `[[Folder/Old]]` in other notes, frontmatter included. Without it, the next click on an old link makes a second note (#1711).

- The sources are the notes whose indexed links resolved to the note, or name its old title or path.
- The core decides which links change (`memry_core::domain::notes::link_rewrite::rewrite_file`), by the same rule as on iOS.
- Each source is edited in its own write turn through the app-edit seam with `Held`. An open editor shows the new link.
- The rename already happened, so a source the seam keeps is not an error. That source keeps its old links, and the log says why.

## Folders

A folder is a directory of the vault. Its settings (icon, default template, `inherit`, saved views) live in its `.folder.md`, which `vault/folder_file.rs` reads and writes byte for byte as Electron does. The vectors are in `crates/memry-desktop/tests/fixtures/electron-vault/folder-md.json`. A `.folder.md` that cannot be read is never replaced. Electron reads such a file as missing and its next write replaces it, saved views included (#720).

The icon is also mirrored into the synced `folder_config` record, so an empty folder reaches other devices (`notes/folders.rs`). The record wins over the file for every read.

- **Rename and move** (`notes/folder_move.rs`). Every note in the folder moves as one note's move does, in one step under the rows' lane. The move is recorded first, then the folder moves on disk (whole, or entry by entry where Windows holds a file open, #2206), then every record, row, `folder_config` record and sidebar slot follows in one transaction. Path-form links (`[[Old/Note]]`) are rewritten afterwards. Moving the journal folder, or a folder holding it, takes the journal setting along, so every day stays a day (see [Journal days](#journal-days)).
- **Delete** (`notes/folder_delete.rs`). The folder goes to the OS trash whole, with every file in it. Its notes are tombstoned and their rows, `folder_config` records and sidebar order removed in one transaction. Electron removes the folder for good. Deleting the journal folder, a folder holding it, or a folder inside it is refused.
- **Another device's changes** (`notes/folder_sync.rs`). A pulled `folder_config` writes its icon into the folder's `.folder.md`, and makes the folder when it is not here. A pulled folder delete, or the last note of a deleted folder going, removes the folder once nothing worth keeping is left in it (`vault/empty_folder.rs`). Nothing calls these yet. The sync engine (Step 17, #3534) will call them through `memry_tauri::shell::folder_sync`.

## Journal days

A day is a core journal record with the id `j<YYYY-MM-DD>` and a vault file at the path the journal date format makes (`journal/`).

- The day's file is made on its first write, not when you open the day (`journal/write.rs`). A create never writes over a file that is already at the day's path.
- A save goes through the app-edit seam with `Save` (`journal/update.rs`). The day's record takes the tags and the property keys the save changed.
- A day's tags live on its record. They are never written back to the day's file: the file's `tags:` are the author's bytes.
- The write-back writes a day's body as it writes a note's. The one frontmatter key it sets is `date` (`vault/writeback/journal.rs`), except when the writing-tools data changes, which rewrites the whole block (a version is kept first).
- The calendar, heatmap and charts read the live journal records (`journal/calendar.rs`, `journal/property_rows.rs`), so a deleted day never shows, whatever file is on disk.
- A day stays a day only while its file is in the configured journal folder, at a name the date format reads. When a file and the setting disagree, the day's next move deletes it as a day and makes a note, on every device. So the setting and the files always change together. **Moving the journal folder in the sidebar**, or a folder holding it, saves the followed folder once the folder is on disk and before the records follow (`notes/folder_move.rs`), as Electron's `followJournalFolderMove` does. A note whose title is a date stays a note. When the records cannot follow, the folder goes back only after the old folder is saved again; a folder that stays moved keeps the followed setting. A crash before the save is finished by the next open, which saves the followed folder before it settles the move (`vault/app_move.rs`); an open that cannot read the settings leaves the move for one that can. The journal folder moves only whole: when Windows holds a file in it, the move is refused instead of going entry by entry. While the settings file cannot be read, no folder moves (`vault_settings_unreadable`), since the app cannot tell where the journal is. Changing the journal folder in Settings is not ported yet and is refused.
- When the whole journal folder is renamed outside the app, each day it carried is held, so no day turns into a note (`journal/folder_follow.rs`). The vault config keeps the old folder name, and the held days stay held.

## Local-only notes

A local-only note's record and text never leave the device (`notes/local_only.rs`). The core owns the rule (`memry_core::domain::notes::local_only`).

- The flag lives on the note's `note_files` row, not in the file.
- While the flag is on, the outbox queues nothing for the note. Turning it on drops what was queued and leaves the server's copy as it was. No tombstone is sent, so other devices keep the last synced version.
- Turning it off queues the record and the whole body, so the server gets everything written while the note was local only. A note too large to sync answers `note_too_large_to_sync`, and the flag stays on.
- Deleting a local-only note sends no tombstone.
- The sidebar marks the note, and the sync status counts local-only notes (`notes_get_local_only_count`).

One difference waits for the sync engine (Step 17): the core still merges a body update another device sends for a local-only note. Electron skips it and pulls the body when the flag is cleared.

## Templates

`templates/mod.rs` serves two kinds of template:

- The 8 built-ins live in code (`memry_core::domain::template_admin`), are read-only and never sync.
- The vault's own templates are synced `template` records.

A new note's template is the one named, else the one a tag names, else the one its folder gives. A folder's template comes from its own `.folder.md` or the nearest folder above that names one, and stops at a folder whose file says `inherit: false` (`vault/folder_file.rs`, `template_of`).

- **Apply to a note** (`notes/apply_template.rs`). `body` replaces the body. `full` also merges the template's tags, fills property names the note does not hold, and sets the icon when the note has none. The edit goes through the app-edit seam with `Replace`, so a version of the old file is kept first. A note whose file holds an edit the document has not read, or whose document is ahead of its file (typing the write-back has not written yet), is refused, and you apply again.
- **A tag's template** (`notes/tag_template.rs`). When a header tag is added to a note that is not a journal day, the first added tag whose schema names a template fills the note's empty body, or is offered when the body has text or the document is ahead of its file. The undo is held in memory for the 100 latest notes, and empties the body only while it still hashes to what the tag put there.
- **Older vaults** (`templates/legacy.rs`). The template files of older builds, `.memry/templates/<id>.md`, are imported into records once per vault as it opens. The files stay on disk for older builds. Deleting a template also removes its file. Beside an Electron database, the files wait for the Electron import (Step 36, #3553).

## Tags and properties

- **The tag hub** (`tags/mod.rs`) edits the synced `tag_definition` and `tag_category` records only, and a pin edits the note record's `pinnedTags`. None of these touches a note file. Renaming, merging and deleting a tag across notes reject with `NotPortedError` and change nothing.
- **Property values** (`notes/properties/`) have one writer. It edits the file's frontmatter block in place through the app-edit seam with `Held`, then writes the keys it changed to the record. A refused edit answers `note_edit_kept`, which the renderer shows as "This note changed while its properties were being saved. Try again."
- **Property definitions** (`notes/property_definitions/`) live in two stores: `.memry/properties.md`, which people edit and older builds share, and the synced `property_definition` records. The app shows their union, and the file wins for every name it lists. Before the file is read or edited, every record a pull changed since the file last took it is written into the file (`settle.rs`, #2896).

## The note index

`notes/index/` measures each note's file into `note_stats` in `index.db` (`0003_note_stats.sql`): word and character counts, snippet, cover, task ids, header tags and journal day.

- One task per open vault does all the work, so no two passes interleave.
- An `Added`, `Changed` or `Renamed` fact queues its note. The queue is worked 500 ms after the first fact of a burst (`IDLE_DELAY`).
- A pass that does not finish leaves its work owed. The next pass pays it, after a backoff from 1 s to 5 minutes.
- Links, body tags and full text have one owner, the core search reindex. When committed links change, the shell sends `NoteLinksChangedEvent`.
- `vault_reindex` measures every note again and reports `VaultIndexProgressEvent` at most every 250 ms, never backwards.

How the commands and events reach the renderer is in [IPC Boundary](/architecture/ipc#tauri-app).

## Differences from Electron

These differences are decided and accepted. Each is stated in the code the item cites.

- **An inline rename stays open when the window loses focus.** WebView2 blurs the focused field when the window is deactivated. The sidebar's inline rename fields and the note title ignore a blur while the window lacks focus (`lib/inline-rename-focus.ts`, `isWindowBlur`). Electron commits or closes the field.
- **A folder delete the trash refuses partway keeps no record.** When the trash took part of the folder and refused the rest, the delete fails with `note_trash_unavailable` and forgets its recorded delete. The watcher reports the notes that went as removed, as for any file that leaves the vault (`notes/folder_delete.rs`).
- **A `.folder.md` with text keeps its folder.** When another device deletes a folder, a `.folder.md` holding text or keys no build models keeps the folder on this device. Electron removes any `.folder.md` (`vault/empty_folder.rs`). This takes effect once the sync engine calls the prune (Step 17).
- **A server delete with no payload removes a property definition.** A pulled delete of a `property_definition` this device never held carries no payload. It still removes the name from `.memry/properties.md` (`memry_core::domain::property_admin::mirror`).
- **Journal tags are never written back to a day's file.** They live on the day's record (`journal/mod.rs`).

Other differences the code states:

- A note delete sends a file that holds text the note never read to the OS trash. Electron unlinks it.
- A folder delete sends the whole folder to the OS trash. Electron removes it for good.
- Neither app has a duplicate-folder action (inv02#6 is not ported).
- A rename that changes only case respells the file in place. Electron numbers it (`Plan 1.md`).
- The **Local only** toggle turns the flag off as well as on, and a failed toggle shows an error. Electron's menu can only turn it on (#3809).
- When a moved note's own embeds cannot be re-pointed, the move's answer says why and the app tells you. Electron only logs it.
- A path link names a note by its folder and title. Electron uses the file's path. The two differ only for a file named other than its title.
