//! Local compaction of the editor's documents (desktop Step 14i, #3531;
//! Electron's `maybeCompact`, `crdt-provider.ts:2220-2251`).
//!
//! The editor counts the bytes each document's local log holds since its last
//! fold: what the log held when the document loaded (rows an earlier launch
//! left), then every committed update its listeners hear that lands in the
//! local namespace (a window's edit, an outside edit, a repair or an app
//! write). Bytes merged from the server are not counted: a local fold cannot
//! shrink the server rows. The shell asks on its timer which documents reach
//! [`COMPACTION_GROWTH_BYTES`] ([`Editor::compaction_due`]) and compacts each
//! ([`Editor::compact`]), which folds the document's local namespace into one
//! snapshot ([`crate::crdt::compact`]).
//!
//! The fold reads the log, not the resident document: it runs on the writer in
//! one transaction, so it holds every row committed before it, whatever the
//! resident copy has caught up with, and a window's edit committed after it
//! lands above the fold point. The resident document is left as it is: it holds
//! the same items, so no window reloads. Pending outbox rows are not touched.
//!
//! A document nobody opens is not counted, and not compacted.

use std::collections::HashMap;
use std::sync::{MutexGuard, PoisonError};

use rusqlite::{Connection, params};

use super::{Editor, EditorError, Notice, Origin};
use crate::api::errors::StorageError;
use crate::crdt::compact::{Folded, fold_compacted};
use crate::crdt::errors::CrdtError;
use crate::crdt::update_log::Namespace;

/// The local log size at which a document is compacted. Not Electron's rule:
/// there 512 KiB of updates only triggers a size check, which compacts when the
/// encoded document passes 1 MiB with no window open and otherwise flushes the
/// store (`crdt-provider.ts:2229-2245`). Here a fold keeps the document's items,
/// so an open window does not stop it, and the local log's size is what it
/// shrinks.
pub const COMPACTION_GROWTH_BYTES: usize = 512 * 1024;

impl Editor {
    /// Every document whose log took [`COMPACTION_GROWTH_BYTES`] or more since
    /// its last compaction, sorted.
    pub fn compaction_due(&self) -> Vec<String> {
        let mut due: Vec<String> = self
            .grown()
            .iter()
            .filter(|(_, bytes)| **bytes >= COMPACTION_GROWTH_BYTES)
            .map(|(id, _)| id.clone())
            .collect();
        due.sort();
        due
    }

    /// Folds `note_id`'s local namespace into one snapshot of its whole state.
    /// `None`: there was nothing to fold, the log waits on an update it lacks,
    /// or the snapshot would not be smaller, and nothing was written. The
    /// growth count restarts whatever the answer, as Electron's does, so a
    /// document that does not shrink is not tried again on every tick.
    pub fn compact(&self, note_id: &str) -> Result<Option<Folded>, EditorError> {
        self.grown().remove(note_id);
        self.on_writer(|conn| Ok(fold_compacted(conn, note_id)?))
    }

    /// Counts a committed local update toward `note_id`'s next compaction; a
    /// purge starts the new document's count from nothing.
    pub(super) fn count_growth(&self, note_id: &str, notice: Notice<'_>) {
        let mut grown = self.grown();
        match notice {
            Notice::Update(_, Origin::Remote) => {}
            Notice::Update(update, _) => {
                let bytes = grown.entry(note_id.to_owned()).or_default();
                *bytes = bytes.saturating_add(update.len());
            }
            Notice::Purged => {
                grown.remove(note_id);
            }
        }
    }

    /// Starts `note_id`'s count at the bytes its local log holds, when the
    /// document loads: what earlier launches left counts.
    pub(super) fn count_loaded(&self, conn: &Connection, note_id: &str) -> Result<(), CrdtError> {
        let held: i64 = conn
            .query_row(
                "SELECT COALESCE(SUM(length(update_blob)), 0) FROM yjs_updates WHERE doc_id = ?1",
                params![Namespace::Local.row_id(note_id)],
                |row| row.get(0),
            )
            .map_err(|error| StorageError::Failed {
                what: format!("could not measure a local log: {error}"),
            })?;
        self.grown().insert(
            note_id.to_owned(),
            usize::try_from(held).unwrap_or_default(),
        );
        Ok(())
    }

    fn grown(&self) -> MutexGuard<'_, HashMap<String, usize>> {
        self.grown.lock().unwrap_or_else(PoisonError::into_inner)
    }
}
