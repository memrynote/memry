//! A note deleted in the app (`deleteNote`, `vault/notes-crud.ts`). In the note's write order
//! and under the rows' lane:
//! 1. the file, first as in Electron, so a file that cannot go fails the delete and leaves the
//!    note whole. A file whose bytes are the ones the note's document took (the row's content
//!    hash) is removed for good; any other file holds text the note never read (an outside edit
//!    not fed yet, a file too large to take), so it goes to the OS trash instead, as the open
//!    reconcile does with a deleted note's file (`vault::writeback::deleted`). Where the trash
//!    refuses it (a Linux mount with no usable `.Trash-<uid>`), the delete fails with
//!    [`NotesError::TrashUnavailable`] and leaves the note whole; the user is asked, and a
//!    delete the user confirmed as permanent unlinks that file (#3813). Either way the
//!    own-write record is told first, so the watcher's report of the removal is the app's;
//! 2. the record: a tombstone for every other device, none for a local-only note, which the
//!    core reads off the row that is still there (`domain::notes::local_only`);
//! 3. the row, then the note's slot in the sidebar order.
//!
//! A record that cannot be tombstoned after its file went fails the delete with the row kept,
//! naming a file that is gone. The next open's watcher reports the removal, and the identity
//! decides on the row's evidence (`identity::removed`): a file that was unlinked held the text
//! the row names, so the note is deleted then; a file that went to the trash held text the note
//! never took, so nothing proves only the file went and the note stays, listed with its file
//! missing. Either way a second delete goes through: the file is gone, so only the record and
//! the row are left to go.
//!
//! Not here yet: the date reminders Electron clears (Step 21) and the locked-folder check
//! (`assertNoteWritable`, Step 13n).

use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};

use memry_core::domain::note_files::NoteFile as Row;

use super::error::{NotesError, SCOPE};
use super::service::NotesService;
use crate::session::OpenVault;
use crate::shell::file_open::Resolution;
use crate::vault::consumer::{Applied, ChangeSource};
use crate::vault::file_types::FileType;
use crate::vault::note_file::hash_file;
use crate::vault::paths::resolve_vault_file;
use crate::vault::watch::EchoGuard;

impl NotesService {
    /// `permanent`: the user confirmed that a file the trash refuses is removed for good.
    pub fn delete(
        &self,
        open: &OpenVault,
        note_id: &str,
        permanent: bool,
    ) -> Result<(), NotesError> {
        self.order
            .run(note_id, || self.delete_now(open, note_id, permanent))
    }

    fn delete_now(
        &self,
        open: &OpenVault,
        note_id: &str,
        permanent: bool,
    ) -> Result<(), NotesError> {
        let root = open.path.as_path();
        let rows = self.tier.rows();
        let session = rows.session_for(&open.vault)?;
        let writer = open.vault.notes_writer(self.store.clone())?;
        let mut lane = rows.lane_of(session)?;
        let Some(row) = lane.files().by_id(note_id)? else {
            return Err(NotesError::NotFound(note_id.to_owned()));
        };
        let echo = self.tier.echo();
        let removed = if holds_unread_text(root, &row) && !permanent {
            self.trash_file(&echo, root, &row.path)
        } else {
            unlink(&echo, root, &row.path).map_err(NotesError::from)
        };
        if let Err(error) = removed {
            tracing::error!(
                scope = SCOPE,
                note_id,
                "a deleted note's file could not be removed: {error}"
            );
            return Err(error);
        }
        writer.delete(note_id.to_owned())?;
        lane.remove(note_id)?;
        lane.publish(Applied::Removed {
            note_id: note_id.to_owned(),
            path: row.path.clone(),
            source: ChangeSource::App,
        });
        drop(lane);
        if let Err(error) = open.vault.note_positions().remove(&row.path) {
            tracing::warn!(
                scope = SCOPE,
                note_id,
                "a deleted note kept its slot: {error}"
            );
        }
        Ok(())
    }

    /// Moves the file at `rel` to the OS trash, told to the own-write record first.
    fn trash_file(&self, echo: &EchoGuard, root: &Path, rel: &str) -> Result<(), NotesError> {
        let Some(path) = removal_target(root, rel)? else {
            return Ok(());
        };
        echo.will_remove(rel);
        (self.trash)(&path).map_err(|error| {
            // Still there: a later removal of it is an outside one.
            echo.cancel_removal(rel);
            NotesError::TrashUnavailable(error)
        })
    }
}

/// Whether the markdown file of `row` holds text its note's document never took: bytes other
/// than the row's content hash names, or a file that cannot be hashed. A missing file holds
/// nothing; a file of another type is the note itself.
fn holds_unread_text(root: &Path, row: &Row) -> bool {
    if row.file_type != FileType::Markdown.as_str() {
        return false;
    }
    match hash_file(root, &row.path) {
        Ok(None) => false,
        Ok(Some(hash)) => row.content_hash.as_deref() != Some(hash.as_str()),
        Err(_) => true,
    }
}

/// Unlinks the vault file at `rel`, told to the own-write record in the same step; one already
/// gone is no error.
pub(super) fn unlink(echo: &EchoGuard, root: &Path, rel: &str) -> io::Result<()> {
    let Some(path) = removal_target(root, rel)? else {
        return Ok(());
    };
    echo.removing(rel, || match std::fs::remove_file(&path) {
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        other => other,
    })
}

/// Where the file at `rel` is, its folder resolved through links and kept inside the vault, or
/// `None` when the folder is gone. The name itself is not resolved, so a file that is a link
/// loses the link and never its target.
fn removal_target(root: &Path, rel: &str) -> io::Result<Option<PathBuf>> {
    let (folder, name) = rel.rsplit_once('/').unwrap_or(("", rel));
    let folder = match folder {
        "" => root.to_path_buf(),
        folder => match resolve_vault_file(root, folder)? {
            Resolution::Inside(real) => real,
            Resolution::Missing => return Ok(None),
            Resolution::Outside => {
                return Err(io::Error::other(
                    "the note's folder resolves outside the vault",
                ));
            }
        },
    };
    Ok(Some(folder.join(name)))
}
