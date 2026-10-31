//! The vault under test in the e2e build (Step 12e-3h, #3529): the edit and the reads the
//! `e2e_note_*` commands make on notes the app's identity (Step 13d) named from their files.

use std::sync::Arc;

use memry_core::api::vault::Vault;
use memry_core::crdt::body_edit::BlockEdit;
use memry_core::seams::secure_store::SecureStore;

/// Retypes the note's first block, as the editor does.
pub fn edit_first_block(
    vault: &Vault,
    store: Arc<dyn SecureStore>,
    note_id: &str,
    text: &str,
) -> Result<(), String> {
    let blocks = vault
        .notes()
        .blocks(note_id.to_owned())
        .map_err(|error| error.to_string())?
        .ok_or("no such note")?;
    let block_id = blocks
        .iter()
        .find_map(|block| block.id.clone())
        .ok_or("the note has no block with an id")?;
    let writer = vault
        .notes_writer(store)
        .map_err(|error| error.to_string())?;
    let edit = BlockEdit::SetText {
        block_id,
        text: text.to_owned(),
    };
    match writer.edit_block(note_id.to_owned(), edit) {
        Ok(true) => Ok(()),
        Ok(false) => Err("the block was not edited".into()),
        Err(error) => Err(error.to_string()),
    }
}

/// The text of the note's body, block by block, one line each.
pub fn body_text(vault: &Vault, note_id: &str) -> Result<String, String> {
    let blocks = vault
        .notes()
        .blocks(note_id.to_owned())
        .map_err(|error| error.to_string())?
        .ok_or("no such note")?;
    Ok(blocks
        .iter()
        .map(|block| block.inline.iter().map(|run| run.text.as_str()).collect())
        .collect::<Vec<String>>()
        .join("\n"))
}

/// A row of `note_files`: the note, its file and the hash the document holds.
pub type NoteFileRow = (String, String, Option<String>);

pub fn note_files(vault: &Vault) -> Result<Vec<NoteFileRow>, String> {
    let files = vault.note_files();
    let rows = files.list_paths().map_err(|error| error.to_string())?;
    rows.into_iter()
        .map(|(note_id, path)| {
            let hash = files
                .by_path(&path)
                .map_err(|error| error.to_string())?
                .and_then(|row| row.content_hash);
            Ok((note_id, path, hash))
        })
        .collect()
}
