//! The files of deleted notes, moved to the OS trash by the open reconcile (the module
//! invariants, "A deleted note's file goes to the OS trash"). Electron removes a note's file
//! when the deletion is pulled (`handleSyncDeletion` of desktop `crdt-writeback.ts`); this
//! catches the files such a removal never reached, and trashes instead of unlinking. A file
//! whose frontmatter does not parse counts as read once its text was taken (#3750): it goes to
//! the trash with its block, which the note never held.

use std::path::Path;

use super::Pass;
use crate::vault::consumer::Applied;
use crate::vault::note_file::read_note;

const SCOPE: &str = "vault_writeback";

/// What became of one deleted note's file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Leftover {
    /// In the trash, and the row removed.
    Trashed,
    /// The file was already gone; the row removed.
    Gone,
    /// The file holds bytes the note did not (edited since its row read it, or never taken),
    /// so it stays, with its row. A file whose frontmatter does not parse is not one of them
    /// once its text was taken: it is trashed.
    Kept,
    /// The trash or the row refused; the file and the row stay for the next open.
    Failed(String),
}

impl Pass {
    /// Moves the file of every tombstoned note whose bytes are still those its row read to
    /// the trash through `trash`, and removes the row. Each row holds the rows' lane from its
    /// check to its removal, so no feed reads a file it moves; between rows the lane is free
    /// for the app, and a `stopped` consumer or a closed session ends the run, leaving the
    /// rest for the next open.
    pub fn trash_deleted(
        &self,
        trash: &dyn Fn(&Path) -> Result<(), String>,
        stopped: &dyn Fn() -> bool,
    ) -> Vec<(String, Leftover)> {
        let rows = match self.vault.note_files().rows_of_deleted_notes() {
            Ok(rows) => rows,
            Err(error) => {
                tracing::error!(
                    scope = SCOPE,
                    "the files of deleted notes could not be listed: {error}"
                );
                return Vec::new();
            }
        };
        let mut done = Vec::with_capacity(rows.len());
        for row in rows {
            if stopped() {
                break;
            }
            let Ok(mut lane) = self.rows.lane_of(self.session) else {
                break;
            };
            // Read under the lane: a row moved or removed since the list is not this one.
            match lane.files().by_id(&row.note_id) {
                Ok(Some(now)) if now == row => {}
                _ => continue,
            }
            let leftover = match read_note(&self.root, &row.path) {
                Ok(None) => Leftover::Gone,
                Ok(Some(file)) if row.content_hash.as_deref() == Some(file.hash.as_str()) => {
                    self.echo.will_remove(&row.path);
                    match trash(&self.root.join(&row.path)) {
                        Ok(()) => Leftover::Trashed,
                        Err(error) => {
                            // Still there: a later removal of it is an outside one.
                            self.echo.seen_present(&row.path);
                            Leftover::Failed(format!("the trash refused it: {error}"))
                        }
                    }
                }
                Ok(Some(_)) => Leftover::Kept,
                Err(error) => Leftover::Failed(format!("the file could not be read: {error}")),
            };
            let leftover = match leftover {
                Leftover::Trashed | Leftover::Gone => match lane.remove(&row.note_id) {
                    Ok(()) => {
                        lane.publish(Applied::Removed {
                            note_id: row.note_id.clone(),
                            path: row.path.clone(),
                        });
                        leftover
                    }
                    Err(error) => Leftover::Failed(format!("the row was not removed: {error}")),
                },
                other => other,
            };
            match &leftover {
                Leftover::Trashed | Leftover::Gone => {
                    tracing::info!(
                        scope = SCOPE,
                        note_id = row.note_id,
                        ?leftover,
                        "a deleted note's file"
                    );
                }
                // A file the document never took (a journal day's, which is not fed) is kept on
                // every open: that is no news.
                Leftover::Kept if row.content_hash.is_none() => tracing::debug!(
                    scope = SCOPE,
                    note_id = row.note_id,
                    "a deleted note's file was never read into it, so it stays"
                ),
                Leftover::Kept => tracing::warn!(
                    scope = SCOPE,
                    note_id = row.note_id,
                    "a deleted note's file was edited since it was read, so it stays"
                ),
                Leftover::Failed(reason) => tracing::error!(
                    scope = SCOPE,
                    note_id = row.note_id,
                    "a deleted note's file stays for the next open: {reason}"
                ),
            }
            done.push((row.note_id, leftover));
        }
        done
    }
}
