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
//! 2. the folder goes to the trash. Where the trash refuses it (a Linux mount with no usable
//!    `.Trash-<uid>`) nothing changes and the delete fails with `note_trash_unavailable`. A
//!    trash that took part of the folder before refusing says so: the watcher reports the
//!    notes that went as removed, as for any file that leaves the vault;
//! 3. every note is tombstoned (none is sent for a local-only one) and loses its row, and the
//!    folder's `folder_config` records and its manual order go, in one core transaction that
//!    forgets the record of step 1 ([`Lane::folder_deleted_by_app`]);
//! 4. [`Applied::Removed`] for each note, under the lane.
//!
//! A failed step 3, or a crash between 2 and 3, leaves the record, and the next open finishes the
//! delete when the folder is gone and forgets it when it is still there
//! ([`crate::vault::app_move::finish_interrupted`]); until then the folder's delete is held back
//! (`move_pending`).
//!
//! Refused: a folder that is not there under exactly that spelling (`folder_not_found`, a stale
//! sidebar; a case-blind disk answers `work` for `Work`, whose rows this delete would miss), one
//! the tree hides or a link leads to (`invalid_folder`), the journal folder or a folder holding
//! it (`folder_holds_journal`), a folder inside it (`folder_in_journal`), and a folder holding a
//! row no note delete can tombstone (the core's `begin`): days are not notes this delete takes.
//! Not here yet: the
//! locked-folder check (Step 14) and the confirmed permanent delete 13f offers a note the trash
//! refuses (#3813).

use std::fs;
use std::io::ErrorKind;
use std::path::Path;

use super::error::{NotesError, SCOPE};
use super::folder_move::within;
use super::folders::{tree_filter, vault_folder};
use super::moves::plain_folders;
use super::service::NotesService;
use crate::session::OpenVault;
use crate::vault::app_move::on_disk;
use crate::vault::config::read_vault_config;
use crate::vault::consumer::{Applied, ChangeSource};

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
        let ids: Vec<&str> = gone.iter().map(|(id, _)| id.as_str()).collect();
        lane.begin_folder_delete(&writer, &folder, &ids)?;
        if let Err(why) = (self.trash)(&on_disk(root, &folder)) {
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

/// The checks before anything goes (module doc).
fn check(root: &Path, folder: &str) -> Result<(), NotesError> {
    if folder.is_empty() {
        return Err(NotesError::InvalidFolder);
    }
    let journal = read_vault_config(root).journal_folder;
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
