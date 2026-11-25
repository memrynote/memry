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
            // Invariant: adoption owes the file a write only when the record is strictly newer
            // than the file, and the write is the `aliases` key alone, made as the in-app alias
            // edit makes it (`notes::aliases::with_aliases`): every other key, comment and the
            // body stay as the file has them, so an older record never rewrites a newer file.
            // A file's list, `aliases: []` included, is its answer under that time rule; a file
            // with no `aliases` key says nothing and the record keeps its names.
            // Window: the owed write is held in memory only (`Pass::mark_record_newer`). A
            // restart before the pass runs drops it, and the next body-only outside edit then
            // gives the record the file's stale list (VERIFY-5808R3 finding 4, a follow-up).
            owes_file = aliases::found(writer, id, text, matched);
            properties::found(writer, ctx, self.store.clone(), id, text)?;
        }
        Ok(match self.adoption(adopted, ctx.root, file.path) {
            Adoption::Existing(id) if owes_file => Adoption::ExistingNewer(id),
            adoption => adoption,
        })
    }
}
