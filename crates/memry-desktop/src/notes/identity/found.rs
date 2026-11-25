//! What a file first named gives the record the identity adopted for it, and the consumer's
//! answer.

use memry_core::api::notes_write::NotesWriter;
use memry_core::domain::notes::identity::Adopted;

use super::{NotesIdentity, aliases, properties};
use crate::vault::consumer::identity::{Adoption, Candidate, IdentityCtx, IdentityError};
use crate::vault::note_file::NoteFile;

impl NotesIdentity {
    /// The record of `file`, whose text is `text`, takes its aliases and property values, and
    /// the consumer is told what the file is.
    pub(super) fn found(
        &self,
        ctx: &IdentityCtx<'_>,
        writer: &NotesWriter,
        adopted: Adopted,
        file: &Candidate<'_>,
        text: &NoteFile,
    ) -> Result<Adoption, IdentityError> {
        let matched = matches!(adopted, Adopted::Existing(_)).then_some(file.modified_ms);
        let mut owes_file = false;
        if let Adopted::Created(id) | Adopted::Existing(id) = &adopted {
            // Invariant: after adoption the file and the record never disagree on aliases. A
            // record newer than its file keeps its names, and the write-back gives them to the
            // file (`Adoption::ExistingNewer`): an outside edit and an in-app alias edit are both
            // measured against the file's list, so neither takes a stale list over them.
            owes_file = aliases::found(writer, id, text, matched);
            properties::found(writer, ctx, self.store.clone(), id, text)?;
        }
        Ok(match self.adoption(adopted, ctx.root, file.path) {
            Adoption::Existing(id) if owes_file => Adoption::ExistingNewer(id),
            adoption => adoption,
        })
    }
}
