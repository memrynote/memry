//! A note deleted in the app (`deleteNote`, `vault/notes-crud.ts`): for good, not to the OS
//! trash. In the note's write order and under the rows' lane:
//! 1. the record: a tombstone for every other device, none for a local-only note, which the
//!    core reads off the row that is still there (`domain::notes::local_only`);
//! 2. the file, told to the own-write record first, so the watcher's report of its removal is
//!    the app's and never an outside delete;
//! 3. the row, then the note's slot in the sidebar order.
//!
//! A file that cannot be removed fails the delete with the row kept: the record is a
//! tombstone and the row still names the file's bytes, so the next open's walk trashes the
//! file (`vault::writeback::deleted`) rather than making it a new note.
//!
//! Not here yet: the date reminders Electron clears (Step 21) and the locked-folder check
//! (`assertNoteWritable`, Step 13n).

use std::io::{self, ErrorKind};
use std::path::Path;

use super::error::{NotesError, SCOPE};
use super::service::NotesService;
use crate::session::OpenVault;
use crate::shell::file_open::Resolution;
use crate::vault::consumer::{Applied, ChangeSource};
use crate::vault::paths::resolve_vault_file;

impl NotesService {
    pub fn delete(&self, open: &OpenVault, note_id: &str) -> Result<(), NotesError> {
        self.order.run(note_id, || self.delete_now(open, note_id))
    }

    fn delete_now(&self, open: &OpenVault, note_id: &str) -> Result<(), NotesError> {
        let root = open.path.as_path();
        let rows = self.tier.rows();
        let session = rows.session_for(&open.vault)?;
        let writer = open.vault.notes_writer(self.store.clone())?;
        let mut lane = rows.lane_of(session)?;
        let Some(row) = lane.files().by_id(note_id)? else {
            return Err(NotesError::NotFound(note_id.to_owned()));
        };
        writer.delete(note_id.to_owned())?;
        let removed = self
            .tier
            .echo()
            .removing(&row.path, || remove_vault_file(root, &row.path));
        if let Err(error) = removed {
            tracing::error!(
                scope = SCOPE,
                note_id,
                "a deleted note's file could not be removed: {error}"
            );
            return Err(error.into());
        }
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
}

/// Unlinks the vault file at `rel`; one already gone is no error. The folder is resolved
/// through links and must stay inside the vault; the name itself is unlinked, so a file that is
/// a link loses the link and never its target.
pub(crate) fn remove_vault_file(root: &Path, rel: &str) -> io::Result<()> {
    let (folder, name) = rel.rsplit_once('/').unwrap_or(("", rel));
    let folder = match folder {
        "" => root.to_path_buf(),
        folder => match resolve_vault_file(root, folder)? {
            Resolution::Inside(real) => real,
            Resolution::Missing => return Ok(()),
            Resolution::Outside => {
                return Err(io::Error::other(
                    "the note's folder resolves outside the vault",
                ));
            }
        },
    };
    match std::fs::remove_file(folder.join(name)) {
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        other => other,
    }
}
