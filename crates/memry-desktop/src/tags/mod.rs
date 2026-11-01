//! The tags of the open vault as the renderer reads them (`ipc/tags-handlers.ts`): the tag list
//! with counts and a tag's notes. Both are reads; neither writes a record or a file.
//!
//! The rules live in the core: which tags a note carries and how they count
//! ([`memry_core::domain::tag_reads`]). This module shapes the answers.

pub mod view;

use memry_core::api::errors::StorageError;

use crate::session::OpenVault;
use view::{NotesByTagInput, NotesByTagView, TagWithCountView};

/// `tags:get-all-with-counts`.
pub fn all_with_counts(open: &OpenVault) -> Result<Vec<TagWithCountView>, StorageError> {
    Ok(open
        .search
        .tag_counts()?
        .into_iter()
        .map(TagWithCountView::from)
        .collect())
}

/// `tags:get-notes-by-tag`. An empty tag is refused (`GetNotesByTagSchema`: `min(1)`).
pub fn notes_by_tag(
    open: &OpenVault,
    input: &NotesByTagInput,
) -> Result<NotesByTagView, StorageError> {
    if input.tag.is_empty() {
        return Err(StorageError::Invalid {
            what: "a tag needs a name".to_owned(),
        });
    }
    let tagged = open.search.tagged_notes(
        &input.tag,
        input.descendants(),
        input.sort(),
        input.ascending(),
    )?;
    Ok(NotesByTagView::of(input.tag.clone(), tagged))
}
