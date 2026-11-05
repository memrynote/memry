//! What a vault file's frontmatter property values give its record (#3530 13k-4c): a found
//! file's, and an outside edit's. The rule is the core's (`memry_core::domain::properties::
//! taken`: what the file changed since the record last took it, else only the keys the record
//! lacks); this reads the file, the definitions' types and the index.

use std::sync::Arc;

use memry_core::api::notes_write::NotesWriter;
use memry_core::domain::property_values::indexed_value;
use memry_core::seams::secure_store::SecureStore;
use serde_json::{Map, Value};

use super::SCOPE;
use crate::notes::properties::{definition_types, file_values};
use crate::vault::consumer::identity::{IdentityCtx, IdentityError};
use crate::vault::note_file::NoteFile;

/// The tier named the file `id`: a new record takes its values, a record that has some keeps
/// each it holds.
pub(super) fn found(
    writer: &NotesWriter,
    ctx: &IdentityCtx<'_>,
    store: Arc<dyn SecureStore>,
    id: &str,
    file: &NoteFile,
) -> Result<(), IdentityError> {
    taken(writer, ctx, store, id, None, file)
}

/// An edit outside the app replaced the note's file, whose hash was `previous`. Without a
/// baseline the index's reading stands in, when it read that file's header.
pub(super) fn edited(
    writer: &NotesWriter,
    ctx: &IdentityCtx<'_>,
    store: Arc<dyn SecureStore>,
    note_id: &str,
    previous: &str,
    file: &NoteFile,
) -> Result<(), IdentityError> {
    let read = ctx.search.note_stats(note_id)?.is_some_and(|stored| {
        stored.file_hash.as_deref() == Some(previous) && stored.stats.header_read
    });
    let indexed = match read {
        true => Some(
            ctx.search
                .note_properties(note_id)?
                .into_iter()
                .map(|row| {
                    let value = row
                        .text
                        .map_or(Value::Null, |text| indexed_value(text, &row.type_name));
                    (row.name, value)
                })
                .collect::<Map<String, Value>>(),
        ),
        false => None,
    };
    taken(writer, ctx, store, note_id, indexed, file)
}

/// A frontmatter that does not parse, or is not a map, says nothing of the values: the record
/// and its baseline stay as they were.
fn taken(
    writer: &NotesWriter,
    ctx: &IdentityCtx<'_>,
    store: Arc<dyn SecureStore>,
    id: &str,
    indexed: Option<Map<String, Value>>,
    file: &NoteFile,
) -> Result<(), IdentityError> {
    let types = definition_types(ctx.root, ctx.vault, store);
    let Some(after) = file_values(file, &types) else {
        tracing::info!(
            scope = SCOPE,
            note_id = id,
            "a file's frontmatter does not read as a map; the record keeps its properties"
        );
        return Ok(());
    };
    writer.file_properties_taken(id, indexed, after)?;
    Ok(())
}
