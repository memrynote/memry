//! The snapshot-meta probe of [`BodyPull`] (§7.8's second clause, for a
//! server that sends no `snapshotMeta` on the single-document route).

use std::collections::HashMap;

use serde_json::{Value as Json, json};

use crate::protocol::http::RetryPolicy;
use crate::sync::crdt_wire::{SnapshotMeta, read_update_page};

use super::{BodyPull, BodyPullError};

impl BodyPull {
    /// The server's snapshot meta for the documents in `doc_ids` that already
    /// hold a cursor, through one `POST /sync/crdt/updates/batch` (the route
    /// that carries `snapshotMeta`, §7.11; desktop's probe). `limit: 1`: the
    /// updates themselves come from the paged pull that follows.
    ///
    /// **A failed probe is not a failed pull.** The batch route has its own,
    /// tighter rate limit, and an old server may not have it; either way the
    /// pull goes on as before, without the second §7.8 clause.
    pub(in crate::sync) async fn probe_snapshot_meta(
        &self,
        doc_ids: &[String],
        requests: &mut usize,
    ) -> Result<HashMap<String, SnapshotMeta>, BodyPullError> {
        let mut notes = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for doc_id in doc_ids {
            // The server refuses a batch naming an id twice.
            if !seen.insert(doc_id.as_str()) {
                continue;
            }
            let cursor = self.read_cursor(doc_id).await?;
            if cursor > 0 {
                notes.push(json!({ "noteId": doc_id, "since": cursor }));
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
        Ok(doc_ids
            .iter()
            .filter_map(|id| {
                read_update_page(&body, id)
                    .snapshot_meta
                    .map(|meta| (id.clone(), meta))
            })
            .collect())
    }
}
