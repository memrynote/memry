//! The open reconcile: a pass for every note whose file was left behind its body (the module
//! invariants, "Every open brings the files left behind"). Electron journals a pulled page's
//! file operations and replays them (`replayBulkApplyJournal` of desktop `bulk-apply.ts`); this
//! derives the same notes from the body stamps instead, so it also finds an edit made in the
//! app whose pass never ran.

use super::{Pass, WriteBack};
use crate::vault::trash::move_to_trash;

const SCOPE: &str = "vault_writeback";

/// Moves the files of deleted notes to the trash, then schedules a pass for every note behind
/// its body. The consumer calls it once the open walk ended.
pub(crate) fn reconcile(pass: &Pass, writeback: &WriteBack) {
    pass.trash_deleted(&move_to_trash);
    match pass.vault.note_files().behind_bodies() {
        Ok(notes) => {
            if !notes.is_empty() {
                tracing::info!(
                    scope = SCOPE,
                    count = notes.len(),
                    "files behind their bodies are written"
                );
            }
            for note_id in &notes {
                writeback.schedule(note_id);
            }
        }
        Err(error) => tracing::error!(
            scope = SCOPE,
            "the files behind their bodies could not be listed, so they wait for the next \
             open: {error}"
        ),
    }
}
