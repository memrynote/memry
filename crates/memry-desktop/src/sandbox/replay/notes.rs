//! The template's markdown notes, created in the staged vault's core under the ids the plan
//! minted, each with the body its file gives it, as the open walk authors a new file's body
//! (`vault::consumer::walked`). No `note_files` row is written: the first open of the vault
//! claims each note for its file by folder, title and body (`identity::adopt`), which is how a
//! note created before its row is found after a crash, so the consumer stays the one writer of
//! rows.

use std::path::Path;
use std::sync::Arc;

use memry_core::api::errors::StorageError;
use memry_core::api::vault::Vault;
use memry_core::domain::external_feed::{FeedInput, FirstBody};
use memry_core::domain::notes::identity::{FileNote, Origin};
use memry_core::domain::notes::new_files::NewFileNote;
use memry_core::seams::secure_store::SecureStore;
use memry_core::storage::OpenOptions;

use super::plan::NewNote;
use crate::notes::identity::file::place;
use crate::sandbox::SandboxError;
use crate::session::prepare_core_dir;
use crate::vault::consumer::{converter_for, writing_of};
use crate::vault::embeds::Resolved;
use crate::vault::note_file::{NoteFile, large_file_class, read_note};

/// Notes created per transaction, which holds the writer for the batch.
const BATCH: usize = 64;

pub(super) fn create(
    root: &Path,
    store: Arc<dyn SecureStore>,
    notes: &[NewNote],
) -> Result<(), SandboxError> {
    let core_error = |error: &dyn std::fmt::Display| SandboxError::Core(error.to_string());
    let core = prepare_core_dir(root, None).map_err(|error| core_error(&error))?;
    let vault = Vault::open_with(
        core.to_string_lossy().into_owned(),
        OpenOptions {
            verify_integrity: true,
        },
    )
    .map_err(|error: StorageError| core_error(&error))?;
    vault
        .record_origin(Origin::Native)
        .map_err(|error| core_error(&error))?;
    let writer = vault
        .notes_writer(store.clone())
        .map_err(|error| core_error(&error))?;
    let feed = vault
        .external_feed(store)
        .map_err(|error| core_error(&error))?;
    let files = vault.note_files();
    let converter = converter_for(None);
    let not_created = |note: &NewNote| SandboxError::NoteNotCreated(note.path.clone());

    for batch in notes.chunks(BATCH) {
        let mut read: Vec<(&NewNote, NoteFile, FirstBody)> = Vec::with_capacity(batch.len());
        for note in batch {
            let file = read_note(root, &note.path)
                .map_err(|error| core_error(&error))?
                .ok_or_else(|| not_created(note))?;
            // A large-file note's body is never authored up front; the template has none.
            if large_file_class(&file.raw).is_some() {
                return Err(not_created(note));
            }
            let split = file.split();
            let embeds = Resolved::of_markdown(root, &files, split.body, &note.path);
            let input = FeedInput {
                note_id: &note.id,
                markdown: split.body,
                note_path: Some(&note.path),
                writing: writing_of(&file),
                frontmatter: split.block,
                embeds: Some(&embeds),
            };
            let body = feed
                .first_body(&converter, input)
                .ok_or_else(|| not_created(note))?;
            read.push((note, file, body));
        }
        let new: Vec<NewFileNote<'_>> = read
            .iter()
            .map(|(note, file, body)| {
                let (folder_path, title) = place(&note.path);
                NewFileNote {
                    file: FileNote {
                        path: &note.path,
                        title,
                        folder_path,
                        body: file.split().body,
                        created_ms: note.created_ms,
                        modified_ms: note.modified_ms,
                        electron_db_beside: false,
                    },
                    id: &note.id,
                    body,
                }
            })
            .collect();
        let created = writer
            .adopt_new_files(&new)
            .map_err(|error| core_error(&error))?;
        if let Some(at) = created.iter().position(|created| !created) {
            return Err(not_created(read[at].0));
        }
    }
    Ok(())
}
