//! Local compaction of the open vault's documents on a timer (Step 14i, #3531; Electron's
//! `maybeCompact`, `crdt-provider.ts:2220-2251`).
//!
//! Every [`COMPACT_EVERY`] the host asks core which documents' logs grew by
//! [`COMPACTION_GROWTH_BYTES`](memry_core::api::editor::COMPACTION_GROWTH_BYTES) since their last
//! compaction and compacts each ([`compact_due`]). Core folds the log, never the window's copy, so
//! an open window keeps typing through it and hears nothing: the body did not change.

use std::time::Duration;

use memry_core::api::editor::Editor;

use crate::session::projection::CancelToken;

/// How often the documents that grew are compacted: Electron's `SIZE_CHECK_INTERVAL_MS`
/// (`crdt-provider.ts:73`).
pub(super) const COMPACT_EVERY: Duration = Duration::from_secs(60);

const SCOPE: &str = "EditorCompaction";

/// Compacts every document `editor` says is due; returns the ones it folded. A document that
/// fails is logged and waits for its next growth. Stops between documents once `cancel` is set
/// (the vault is closing), so a close never waits on more than one fold.
pub fn compact_due(editor: &Editor, cancel: &CancelToken) -> Vec<String> {
    let mut folded = Vec::new();
    for note_id in editor.compaction_due() {
        if cancel.is_cancelled() {
            break;
        }
        match editor.compact(&note_id) {
            Ok(Some(fold)) => {
                tracing::info!(
                    scope = SCOPE,
                    note_id,
                    saved_bytes = fold.saved_bytes,
                    "compacted a document's log"
                );
                folded.push(note_id);
            }
            Ok(None) => {
                tracing::debug!(scope = SCOPE, note_id, "nothing to compact");
            }
            Err(error) => {
                tracing::warn!(scope = SCOPE, note_id, %error, "could not compact a document's log");
            }
        }
    }
    folded
}
