//! The open reconcile: a pass for every note whose file was left behind its body (the module
//! invariants, "Every open brings the files left behind"), for every note with no file, and for
//! every pulled place a quit left before its pass (`place`). Electron journals a pulled page's
//! file operations and replays them (`replayBulkApplyJournal` of desktop `bulk-apply.ts`); this
//! derives the same notes from the body stamps instead, so it also finds an edit made in the
//! app whose pass never ran.

use std::collections::BTreeSet;

use super::place::PARKED;
use super::{Pass, WriteBack};
use crate::vault::trash::move_to_trash;

const SCOPE: &str = "vault_writeback";

/// Moves the files of deleted notes to the trash, those owed a move only when the open's
/// crossings left the file theirs (`theirs`), marks the rows an older build stamped whose body
/// is not ahead of them, then schedules a pass for every note behind its body or whose file
/// owes its record's aliases. The consumer
/// calls it once the open walk ended; a stop of the consumer ends the trashing between files
/// (`stopped`).
pub(crate) fn reconcile(
    pass: &Pass,
    writeback: &WriteBack,
    theirs: &BTreeSet<String>,
    stopped: &dyn Fn() -> bool,
) {
    pass.trash_deleted(theirs, &move_to_trash, stopped);
    // An outside edit of an unmarked row is compared through its file, which reads a change of
    // the frontmatter as typing (#4097).
    if let Err(error) = pass.vault.note_files().mark_unmarked() {
        tracing::error!(
            scope = SCOPE,
            "the rows an older build stamped were not marked, so they wait for the next open: \
             {error}"
        );
    }
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
    // A file that owes its record's aliases: a quit before its pass, or a pass that kept the
    // file (`owed`, #5828).
    match pass.vault.note_files().owed_file_aliases() {
        Ok(notes) => {
            for note_id in &notes {
                writeback.schedule(note_id);
            }
        }
        Err(error) => tracing::error!(
            scope = SCOPE,
            "the files owing their records' aliases could not be listed, so they wait for the \
             next open: {error}"
        ),
    }
    // A record pulled with no file written for it: a crash between the pull's commit and its
    // pass, or a vault synced by a build that wrote none (#3534 L5b).
    match pass.vault.note_files().unfiled_bodies() {
        Ok(notes) => {
            if !notes.is_empty() {
                tracing::info!(
                    scope = SCOPE,
                    count = notes.len(),
                    "unfiled notes get their files"
                );
            }
            for note_id in &notes {
                writeback.schedule(note_id);
            }
        }
        Err(error) => tracing::error!(
            scope = SCOPE,
            "the unfiled notes could not be listed, so they wait for the next open: {error}"
        ),
    }
    // A pulled place or frontmatter a quit left before its pass (`place`, #5309).
    match pass.vault.note_files().pulled_notes(PARKED) {
        Ok(notes) => {
            if !notes.is_empty() {
                tracing::info!(
                    scope = SCOPE,
                    count = notes.len(),
                    "pulled places reach their files"
                );
            }
            for note_id in &notes {
                writeback.schedule(note_id);
            }
        }
        Err(error) => tracing::error!(
            scope = SCOPE,
            "the pulled notes could not be listed, so they wait for the next open: {error}"
        ),
    }
}
