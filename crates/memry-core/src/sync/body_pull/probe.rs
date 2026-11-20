//! The snapshot-meta probe of [`BodyPull`] (§7.8's second clause, for a
//! server that sends no `snapshotMeta` on the single-document route), and the
//! proof that a document holding a cursor has nothing left to pull.

use std::collections::HashMap;

use serde_json::{Value as Json, json};

use crate::protocol::http::RetryPolicy;
use crate::sync::crdt_wire::{SnapshotMeta, read_update_page};

use super::{BodyPull, BodyPullError};

/// What the probe learned about one document that holds a cursor.
#[derive(Debug, Clone, Default)]
pub(in crate::sync) struct Probed {
    pub(in crate::sync) meta: Option<SnapshotMeta>,
    /// The server holds nothing this device lacks: no update above the
    /// cursor, and either no snapshot or the very snapshot this device took
    /// with its cursor at or past its watermark. A pull would fetch nothing
    /// and take no baseline (§7.8), so [`BodyPull::pull_with`] sends none.
    pub(in crate::sync) current: bool,
}

impl BodyPull {
    /// The server's view of the documents in `doc_ids` that already hold a
    /// cursor, through one `POST /sync/crdt/updates/batch` (the route that
    /// carries `snapshotMeta`, §7.11; desktop's probe). `limit: 1`: the
    /// updates themselves come from the paged pull that follows.
    ///
    /// **A failed probe is not a failed pull.** The batch route has its own,
    /// tighter rate limit, and an old server may not have it; either way the
    /// pull goes on as before, without the second §7.8 clause.
    pub(in crate::sync) async fn probe_snapshot_meta(
        &self,
        doc_ids: &[String],
        requests: &mut usize,
    ) -> Result<HashMap<String, Probed>, BodyPullError> {
        let mut cursors = HashMap::new();
        let mut notes = Vec::new();
        for doc_id in doc_ids {
            // The server refuses a batch naming an id twice.
            if cursors.contains_key(doc_id) {
                continue;
            }
            // A cursor of `0` is held too (#4315's empty body), so a resumed
            // first sync can tell it is still empty without re-pulling it.
            if let Some(cursor) = self.stored_cursor(doc_id).await? {
                notes.push(json!({ "noteId": doc_id, "since": cursor }));
                cursors.insert(doc_id.clone(), cursor);
            }
        }
        if notes.is_empty() {
            return Ok(HashMap::new());
        }
        // Counted against the caller's per-pass budget like any other request.
        *requests += 1;
        let request = self
            .request("POST", "/sync/crdt/updates/batch")
            .json(&json!({ "notes": notes, "limit": 1 }))
            // No retries: a failed probe only means the pull goes on without
            // the meta, so waiting through backoff buys nothing.
            .retry(RetryPolicy::never());
        let Ok(body) = self.http.send_json::<Json>(request).await else {
            return Ok(HashMap::new());
        };
        // An older server sends no `snapshotMeta` key at all, so an empty
        // answer there could hide a snapshot that pruned past the cursor.
        let advertises_snapshots = body.get("snapshotMeta").is_some_and(Json::is_object);
        let mut probed = HashMap::new();
        for (doc_id, cursor) in cursors {
            let page = read_update_page(&body, &doc_id);
            // A note the server left out of `notes` reads as an empty page.
            let answered = body
                .get("notes")
                .and_then(|notes| notes.get(&doc_id))
                .is_some();
            let nothing_new =
                advertises_snapshots && answered && page.updates.is_empty() && !page.has_more;
            let current = nothing_new
                && match &page.snapshot_meta {
                    None => true,
                    // §7.8's first clause: cursor `0` always takes a snapshot
                    // that exists.
                    Some(meta) => {
                        cursor > 0
                            && cursor >= meta.sequence_num
                            && !self.baseline_due(&doc_id, meta).await?
                    }
                };
            probed.insert(
                doc_id,
                Probed {
                    meta: page.snapshot_meta,
                    current,
                },
            );
        }
        Ok(probed)
    }
}
