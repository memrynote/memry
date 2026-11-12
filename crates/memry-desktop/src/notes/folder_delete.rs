//! A folder deleted in the app (`deleteFolder` of `vault/notes-crud.ts` and
//! `deleteFolderCommand` of `notes/domain.ts`): the sidebar's delete of a folder, with every note
//! and folder in it.
//!
//! Electron removed the folder for good (`rm -rf`) and left its notes to the watcher. Here the
//! folder goes to the OS trash whole, so a file no note took (an outside edit not fed yet, a file
//! the index does not take, `.folder.md`) can still be had back, and the notes follow in one step
//! under the rows' lane. The watcher applies what it sees through that lane too, so it finds the
//! rows gone and reports nothing:
//! 1. the delete is recorded in the core ([`Lane::begin_folder_delete`], one synced write);
//! 2. the folder goes to the trash, with the text of each kept note in it (a note whose file was
//!    deleted outside the app, `notes::kept`) written in it first, as a kept note's delete
//!    does. A kept note whose text cannot be written refuses the delete before anything goes,
//!    with [`NotesError::FolderKeptUnwritable`] naming why (`folder_kept_not_pulled` when the
//!    text has not synced to this device yet); the delete of that note alone asks whether it
//!    goes for good. Where the trash refuses it (a Linux mount with no usable
//!    `.Trash-<uid>`) nothing changes and the delete fails with `note_trash_unavailable`. A
//!    trash that took part of the folder before refusing says so: the watcher reports the
//!    notes that went as removed, as for any file that leaves the vault;
//! 3. every note is tombstoned (none is sent for a local-only one) and loses its row, and the
//!    folder's `folder_config` records and its manual order go, in one core transaction that
//!    forgets the record of step 1 ([`Lane::folder_deleted_by_app`]);
//! 4. [`Applied::Removed`] for each note, under the lane.
//!
//! A crash in step 2, between the kept notes' copies and the trash, leaves the record and the
//! copies: the next open forgets the record of the folder still there, and the watcher reads
//! each copy at its note's path as the note's file again, which undoes the delete with nothing
//! lost. A copy written beside a file at its note's path sits in a hidden folder that no walk
//! reads, so it is no new note while its note is kept; the open shows it once no kept note
//! owns it (`vault::kept_copies`).
//!
//! A failed step 3, or a crash between 2 and 3, leaves the record, and the next open finishes the
//! delete when the folder is gone and forgets it when it is still there
//! ([`crate::vault::app_move::finish_interrupted`]); until then the folder's delete is held back
//! (`move_pending`).
//!
//! Refused: a folder that is not there under exactly that spelling (`folder_not_found`, a stale
//! sidebar; a case-blind disk answers `work` for `Work`, whose rows this delete would miss), one
//! the tree hides or a link leads to (`invalid_folder`), the journal folder or a folder holding
//! it (`folder_holds_journal`), a folder inside it (`folder_in_journal`), any folder while the
//! settings that say where the journal is cannot be read (`vault_settings_unreadable`), and a
//! folder holding a row no note delete can tombstone (the core's `begin`): days are not notes
//! this delete takes. While a journal setting change a crash cut short waits, a folder that is,
//! holds or is inside either of its folders is refused too (`journal_change_waits`, as the
//! folder move refuses it, `vault::journal_rename`): its days would go as days, or wait to go
//! back to a folder that is gone. A folder that is locked, sits in a locked folder or holds a lock
//! is refused (`folder_locked`, `assertFolderTreeWritable`), and so is a folder holding a note
//! under an exclude pattern (`note_excluded`), which is read-only. Not here yet: the confirmed
//! permanent delete 13f offers a note the trash refuses (#3813).

use std::fs;
use std::io::ErrorKind;
use std::path::Path;

use memry_core::domain::note_files::NoteFile as Row;

use super::error::{NotesError, SCOPE};
use super::folder_move::within;
use super::folders::{tree_filter, vault_folder};
use super::kept::KeptCopy;
use super::moves::{disk_spelling, plain_folders};
use super::service::NotesService;
use crate::journal::folder_follow::follow_moved_journal;
use crate::locks::{Locks, Refused};
use crate::session::OpenVault;
use crate::vault::app_move::on_disk;
use crate::vault::config::read_vault_config_strict;
use crate::vault::config::settings::JournalFollow;
use crate::vault::consumer::{Applied, ChangeSource};
use crate::vault::journal_format::normalize_journal_folder;
use crate::vault::journal_rename::{JournalVault, finish_journal_change};
use crate::vault::watch::EchoGuard;

impl NotesService {
    pub fn delete_folder(&self, open: &OpenVault, path: &str) -> Result<(), NotesError> {
        self.delete_folder_checked(open, path, &mut || Ok(()))
    }

    /// [`Self::delete_folder`] with a hook once the folder left the disk, before its notes
    /// follow, so a test can fail that step.
    #[doc(hidden)]
    pub fn delete_folder_checked(
        &self,
        open: &OpenVault,
        path: &str,
        after_disk: &mut dyn FnMut() -> Result<(), NotesError>,
    ) -> Result<(), NotesError> {
        let root = open.path.as_path();
        let folder = vault_folder(root, path)?;
        // A journal folder moved outside the app has its setting follow first, so the folder
        // that holds the days is refused as the journal's (`journal::folder_follow`).
        let notices = self.tier.identity().notices();
        let writer = open.vault.notes_writer(self.store.clone())?;
        let held = follow_moved_journal(root, &writer, notices.as_deref());
        if held.holds(&folder) {
            return Err(NotesError::JournalFolderHeld);
        }
        // Nothing locked goes with the folder.
        Locks::of(open).refuse_folder_tree(&disk_spelling(root, &folder))?;
        // Before the lane: the settings' locks come first (`settings`'s lock order). Held to the
        // end, so no journal setting moves into the folder after `check` read it.
        let settings = JournalFollow::hold();
        let at = JournalVault {
            root,
            vault: &open.vault,
            tier: &self.tier,
        };
        if finish_journal_change(at, &settings).is_some_and(|waits| waits.holds(&folder)) {
            return Err(NotesError::JournalChangeWaits);
        }
        check(root, &folder)?;
        let rows = self.tier.rows();
        let session = rows.session_for(&open.vault)?;
        let writer = open.vault.notes_writer(self.store.clone())?;
        let mut lane = rows.lane_of(session)?;
        let gone: Vec<(String, String)> = lane
            .files()
            .list_paths()?
            .into_iter()
            .filter(|(_, at)| within(at, &folder))
            .collect();
        // A note under an exclude pattern is read-only (#3530): a folder holding one stays, and
        // no delete of the note syncs.
        if gone.iter().any(|(_, at)| open.vault.excluded().covers(at)) {
            return Err(NotesError::Locked(Refused::Excluded));
        }
        // A kept note's text goes to the trash with the folder, written in it first
        // (`notes::kept`); one that cannot be written refuses the delete, naming why.
        let mut copies = Vec::new();
        for (note_id, _) in &gone {
            let Some(row) = lane.files().by_id(note_id)? else {
                continue;
            };
            match self.write_kept_copy(&lane, open, &row) {
                Ok(Some(copy)) => copies.push((row, copy)),
                Ok(None) => {}
                Err(error) => {
                    take_back(&self.tier.echo(), root, &copies);
                    return Err(match error {
                        NotesError::EditKept(kept) => NotesError::FolderKeptUnwritable(kept),
                        error => error,
                    });
                }
            }
        }
        let ids: Vec<&str> = gone.iter().map(|(id, _)| id.as_str()).collect();
        if let Err(error) = lane.begin_folder_delete(&writer, &folder, &ids) {
            take_back(&self.tier.echo(), root, &copies);
            return Err(error.into());
        }
        // A copy in a hidden folder (one beside a file at its note's path) goes on its own
        // first, so the trash shows it.
        let trashed = copies
            .iter()
            .filter(|(row, copy)| copy.at != row.path)
            .try_for_each(|(_, copy)| (self.trash)(&on_disk(root, &copy.at)))
            .and_then(|()| (self.trash)(&on_disk(root, &folder)));
        if let Err(why) = trashed {
            take_back(&self.tier.echo(), root, &copies);
            if let Err(error) = lane.forget_folder_delete(&writer, &folder) {
                tracing::warn!(
                    scope = SCOPE,
                    "the record of a refused folder delete waits for the next open: {error}"
                );
            }
            // What the trash took is gone from the vault, and the watcher reports it so.
            let went = gone
                .iter()
                .filter(|(_, at)| matches!(fs::symlink_metadata(on_disk(root, at)), Err(error) if error.kind() == ErrorKind::NotFound))
                .count();
            if went > 0 {
                tracing::warn!(
                    scope = SCOPE,
                    went,
                    "the trash took part of the folder and refused the rest"
                );
                return Err(NotesError::TrashUnavailable(format!(
                    "{why}; part of the folder went to the trash ({went} of {} notes)",
                    gone.len()
                )));
            }
            return Err(NotesError::TrashUnavailable(why));
        }
        // The copies went with the folder: a file put back from the trash at a copy's path is
        // not the app's write.
        let echo = self.tier.echo();
        for (_, copy) in &copies {
            echo.cancel_write(&copy.at);
        }
        // The folder is in the trash: a failure leaves the record, which the next open finishes.
        after_disk().and_then(|()| Ok(lane.folder_deleted_by_app(&writer, &folder, &ids)?))?;
        for (note_id, at) in &gone {
            lane.publish(Applied::Removed {
                note_id: note_id.clone(),
                path: at.clone(),
                source: ChangeSource::App,
            });
        }
        Ok(())
    }
}

/// Takes back the kept notes' copies a folder delete that did not happen wrote: the notes stay
/// kept. A copy the trash took is gone already. Last written first: a copy that made a folder
/// removes it only once the later copies in it are gone.
fn take_back(echo: &EchoGuard, root: &Path, copies: &[(Row, KeptCopy)]) {
    for (row, copy) in copies.iter().rev() {
        copy.take_back(echo, root, &row.note_id);
    }
}

/// The checks before anything goes (module doc).
fn check(root: &Path, folder: &str) -> Result<(), NotesError> {
    if folder.is_empty() {
        return Err(NotesError::InvalidFolder);
    }
    // Settings that cannot be read do not say where the journal is: their defaults would let
    // the journal folder go unless it is named `journal`. Read as the days are:
    // `/Personal/journal/` is `Personal/journal`.
    let config = read_vault_config_strict(root).map_err(NotesError::SettingsUnreadable)?;
    let journal = normalize_journal_folder(&config.journal_folder);
    if !journal.is_empty() && within(&journal, folder) {
        return Err(NotesError::FolderHoldsJournal);
    }
    if !journal.is_empty() && within(folder, &journal) {
        return Err(NotesError::FolderInJournal);
    }
    let shown = tree_filter(root);
    if folder.split('/').any(|segment| segment.starts_with('.')) || !shown(folder) {
        return Err(NotesError::InvalidFolder);
    }
    // A link would take the trash to what it leads to, a folder the open walk does not enter.
    if !plain_folders(root, folder)? {
        return Err(NotesError::InvalidFolder);
    }
    match fs::symlink_metadata(on_disk(root, folder)) {
        Ok(meta) if meta.is_dir() => {}
        Ok(_) => return Err(NotesError::InvalidFolder),
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return Err(NotesError::FolderNotFound);
        }
        Err(error) => return Err(error.into()),
    }
    if !spelled_on_disk(root, folder)? {
        return Err(NotesError::FolderNotFound);
    }
    Ok(())
}

/// Whether every segment of `folder` is an entry of its parent under exactly that name. The
/// rows name a folder in the spelling the disk lists, so another case or Unicode form, which a
/// case- or normalization-blind disk resolves to the same folder, would trash it with none of
/// its notes.
fn spelled_on_disk(root: &Path, folder: &str) -> std::io::Result<bool> {
    let mut dir = root.to_path_buf();
    for segment in folder.split('/') {
        let mut found = false;
        for entry in fs::read_dir(&dir)? {
            if entry?.file_name() == segment {
                found = true;
                break;
            }
        }
        if !found {
            return Ok(false);
        }
        dir.push(segment);
    }
    Ok(true)
}
