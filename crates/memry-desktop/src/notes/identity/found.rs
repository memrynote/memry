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
            // Invariant: after adoption the file and the record agree on aliases. The file owes
            // a write when the record is strictly newer than it, or when the file has no
            // `aliases` key and the record has names, whatever the times: a keyless file states
            // nothing, so the key added overrides nothing, and a later body-only outside edit
            // reads the record's names back (`aliases::edited`). The write is the `aliases` key
            // alone, made as the in-app alias edit makes it (`notes::aliases::with_aliases`):
            // every other key, comment and the body stay as the file has them. A file's list,
            // `aliases: []` included, is its answer when the record is not newer.
            // The core records the debt with the decision, in `data.db`
            // (`owed_file_aliases`): a restart before the pass, or an outside edit of the body
            // alone before it, keeps the record's names, and the open reconcile writes them.
            owes_file = aliases::found(writer, id, text, matched);
            properties::found(writer, ctx, self.store.clone(), id, text)?;
        }
        Ok(match self.adoption(adopted, ctx.root, file.path) {
            Adoption::Existing(id) if owes_file => Adoption::ExistingNewer(id),
            adoption => adoption,
        })
    }
}
