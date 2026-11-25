//! A record that kept frontmatter newer than its file's when the file was first named
//! ([`Adoption::ExistingNewer`], or a large file's note that left the class): the write-back
//! gives the file the record's, so the two never disagree once it ran.

use super::super::identity::IdentityError;
#[cfg(doc)]
use super::super::identity::{Adoption, NoteIdentity};
use super::super::rows::Lane;
use super::Applier;
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

    /// The note's record kept frontmatter newer than its file's ([`Adoption::ExistingNewer`]):
    /// its write-back gives the file the record's frontmatter, in place, and the body as a
    /// normal pass writes it. It runs under the lane this fact holds, so after the row and body
    /// the fact records; the file it writes is the app's own, which pushes nothing.
    pub(super) fn owe_record(&self, note_id: &str) {
        if let (Some(pass), Some(writeback)) = (&self.pass, &self.writeback) {
            pass.mark_record_newer(note_id);
            writeback.schedule(note_id);
        }
    }
}
