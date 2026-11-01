//! The sidebar's manual order of notes and folders (`notes:reorder`, `notes:get-all-positions`
//! of `ipc/notes-handlers.ts`), over the core's device-local `note_positions`
//! ([`memry_core::domain::note_positions`]). As in Electron, a reorder writes the paths the
//! renderer sends as they are; a rename or move carries its own slot in its transaction.

use std::collections::BTreeMap;

use super::error::NotesError;
use crate::session::OpenVault;

/// `paths` become the order of `folder` (`""` is the root): slot `i` for the item at `i`.
pub fn reorder(open: &OpenVault, folder: &str, paths: Vec<String>) -> Result<(), NotesError> {
    Ok(open.vault.note_positions().reorder(folder, paths)?)
}

/// Every ordered item's slot, by its vault-relative path.
pub fn all(open: &OpenVault) -> Result<BTreeMap<String, i64>, NotesError> {
    let rows = open.vault.note_positions().all()?;
    Ok(rows
        .into_iter()
        .map(|row| (row.path, row.position))
        .collect())
}
