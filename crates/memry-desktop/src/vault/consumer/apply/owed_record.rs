//! A record strictly newer than its file that kept its `aliases` when the file was first named
//! ([`Adoption::ExistingNewer`], or a large file's note that left the class): the file owes the
//! record's list ([`memry_core::domain::owed_file_aliases`], recorded by the core with the
//! decision), and the write-back writes the file's `aliases` key alone, so the two agree on
//! names once it ran. The debt is in `data.db`, so a restart before the pass loses nothing: the
//! open reconcile schedules it again (`vault::writeback::reconcile`).

use super::super::identity::IdentityError;
#[cfg(doc)]
use super::super::identity::{Adoption, NoteIdentity};
use super::super::rows::Lane;
use super::{Applier, SCOPE};
use crate::vault::note_file::NoteFile;

impl Applier {
    /// The identity's [`NoteIdentity::left_large_class`], when the note's file was large.
    pub(super) fn left_large(
        &self,
        lane: &Lane<'_>,
        note_id: &str,
        file: &NoteFile,
        modified_ms: i64,
    ) -> Result<(), IdentityError> {
        if !lane.files().is_large_file(note_id)? {
            return Ok(());
        }
        if self
            .identity
            .left_large_class(&self.ctx(), note_id, file, modified_ms)?
        {
            self.owe_record(note_id);
        }
        Ok(())
    }

    /// The note's file owes its record's aliases ([`Adoption::ExistingNewer`]): its write-back
    /// writes the file's `aliases` key alone, in place, every other key and comment as the file
    /// has them, and the body as a normal pass writes it (a large file's body is copied as it
    /// is). It runs under the lane this fact holds, so after the row and body the fact records;
    /// the file it writes is the app's own, which pushes nothing.
    pub(super) fn owe_record(&self, note_id: &str) {
        if let Some(writeback) = &self.writeback {
            writeback.schedule(note_id);
        }
    }

    /// An outside edit that kept a debt (its body edited alone) has the write-back pay it now
    /// that the row names the edited file.
    pub(super) fn owe_record_if_owed(&self, note_id: &str) {
        match self.vault.note_files().owes_file_aliases(note_id) {
            Ok(true) => self.owe_record(note_id),
            Ok(false) => {}
            Err(error) => tracing::warn!(
                scope = SCOPE,
                note_id,
                "whether the file owes its record's aliases was not read; the next open writes \
                 them: {error}"
            ),
        }
    }
}
