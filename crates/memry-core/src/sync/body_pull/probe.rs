//! The batch probe of [`BodyPull`]: one `POST /sync/crdt/updates/batch` per
//! hundred documents, which answers §7.8's snapshot meta (the single-document
//! route sends none) and each document's first page of updates (#5293).

use std::collections::HashMap;

use serde_json::{Value as Json, json};

use crate::protocol::http::RetryPolicy;
use crate::sync::crdt_wire::{SnapshotMeta, UpdatePage, read_update_page};

use super::{BodyPull, BodyPullError, CRDT_UPDATES_PAGE_LIMIT};

/// What the probe learned about one document.
#[derive(Debug, Clone, Default)]
pub(in crate::sync) struct Probed {
    pub(in crate::sync) meta: Option<SnapshotMeta>,
    /// The server holds nothing this device lacks: a held cursor, no update
    /// above it, and either no snapshot or the very snapshot this device
    /// took. A pull would fetch nothing and take no baseline (§7.8), so
    /// [`BodyPull::pull_with`] sends none.
    pub(in crate::sync) current: bool,
    /// The answer is complete enough to stand in for the snapshot GET's
    /// verdict and the first updates GET: the server advertises its
    /// snapshots, answered this document, and its meta (or its absence, §7.11:
    /// no server snapshot) parsed. `page` holds the updates above `since`.
    pub(in crate::sync) answer: Option<ProbeAnswer>,
}

#[derive(Debug, Clone)]
pub(in crate::sync) struct ProbeAnswer {
    pub(in crate::sync) since: i64,
    pub(in crate::sync) page: UpdatePage,
}

impl BodyPull {
    /// The server's view of `doc_ids` (at most a batch, §7.3), each asked from
    /// its cursor, or from `0` when it holds none. `limit` is the sweep page
    /// size §7.3.1 asks for, so the answer is the first page itself.
    ///
    /// **A failed probe is not a failed pull.** The batch route has its own,
    /// tighter rate limit, and an old server may not have it; either way each
    /// document is pulled as before, through its own routes.
    pub(in crate::sync) async fn probe(
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
            let cursor = self.stored_cursor(doc_id).await?;
            notes.push(json!({ "noteId": doc_id, "since": cursor.unwrap_or(0) }));
            cursors.insert(doc_id.clone(), cursor);
        }
        if notes.is_empty() {
            return Ok(HashMap::new());
        }
        // Counted against the caller's per-pass budget like any other request.
        *requests += 1;
        let request = self
            .request("POST", "/sync/crdt/updates/batch")
            .json(&json!({ "notes": notes, "limit": CRDT_UPDATES_PAGE_LIMIT }))
            // No retries: a failed probe only means each document is pulled
            // through its own routes, so waiting through backoff buys nothing.
            .retry(RetryPolicy::never());
        let Ok(body) = self.http.send_json::<Json>(request).await else {
            return Ok(HashMap::new());
        };
        // An older server sends no `snapshotMeta` key at all, so an empty
        // answer there could hide a snapshot that pruned past the cursor.
        let metas = body.get("snapshotMeta").filter(|metas| metas.is_object());
        let mut probed = HashMap::new();
        for (doc_id, cursor) in cursors {
            let page = read_update_page(&body, &doc_id);
            // A note the server left out of `notes` reads as an empty page.
            let answered = body
                .get("notes")
                .and_then(|notes| notes.get(&doc_id))
                .is_some();
            // §7.11: an id absent from `snapshotMeta` (or null) has no server
            // snapshot. A present entry that does not parse is not "none".
            let meta_read = match metas.map(|metas| metas.get(&doc_id)) {
                Some(None | Some(Json::Null)) => true,
                Some(Some(_)) => page.snapshot_meta.is_some(),
                None => false,
            };
            let trusted = answered && meta_read;
            let current = trusted
                && page.updates.is_empty()
                && !page.has_more
                && match (cursor, &page.snapshot_meta) {
                    (None, _) => false,
                    (Some(_), None) => true,
                    // The revision held is the snapshot's own baseline, at any
                    // `sequenceNum`, 0 included (a snapshot pushed before any
                    // update row).
                    (Some(cursor), Some(meta)) => {
                        cursor >= meta.sequence_num && !self.baseline_due(&doc_id, meta).await?
                    }
                };
            probed.insert(
                doc_id,
                Probed {
                    meta: page.snapshot_meta.clone(),
                    current,
                    answer: trusted.then(|| ProbeAnswer {
                        since: cursor.unwrap_or(0),
                        page,
                    }),
                },
            );
        }
        Ok(probed)
    }
}
