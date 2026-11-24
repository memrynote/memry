//! The batch probe of [`BodyPull`]: one `POST /sync/crdt/updates/batch` per
//! hundred documents, which answers §7.8's snapshot meta (the single-document
//! route sends none) and each document's first page of updates (#5293).

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::{Value as Json, json};

use crate::api::errors::StorageError;
use crate::crdt::epoch::{self, Epoch};
use crate::crdt::update_log;
use crate::protocol::http::{HttpClient, RetryPolicy};
use crate::sync::crdt_wire::{SnapshotMeta, UpdatePage, read_update_page};
use crate::sync::store;

use super::{BodyPull, BodyPullError, CRDT_UPDATES_PAGE_LIMIT, RateLimitPauses, crdt_cursor_scope};

/// What the probe learned about one document.
#[derive(Debug, Default)]
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

#[derive(Debug)]
pub(in crate::sync) struct ProbeAnswer {
    pub(in crate::sync) since: i64,
    /// The body's epoch when the page was asked for (#5356).
    pub(in crate::sync) epoch: Epoch,
    pub(in crate::sync) page: UpdatePage,
}

impl BodyPull {
    /// The client this pull sends through, for a caller pausing on its behalf.
    pub(crate) fn http(&self) -> &Arc<HttpClient> {
        &self.http
    }

    /// The server's view of `doc_ids` (at most a batch, §7.3), each asked from
    /// its cursor, or from `0` when it holds none. `limit` is the sweep page
    /// size §7.3.1 asks for, so the answer is the first page itself.
    ///
    /// **A failed probe is not a failed pull.** The batch route has its own,
    /// tighter rate limit, and an old server may not have it; either way each
    /// document is pulled as before, through its own routes.
    ///
    /// `pauses` are the 429s the probe may still wait out (#5570), the whole
    /// bodies pass's in a first sync (#5423). The first sync waits: without a
    /// probe, a document holding no cursor costs a snapshot GET and an
    /// updates GET, so a refused probe of a hundred empty-body documents
    /// became two hundred route pulls. A pass's body step waits none: it runs
    /// under the pass gate and must not hold the push behind a wait.
    pub(in crate::sync) async fn probe(
        &self,
        doc_ids: &[String],
        requests: &mut usize,
        pauses: &mut RateLimitPauses,
    ) -> Result<HashMap<String, Probed>, BodyPullError> {
        Ok(self.probe_paced(doc_ids, requests, pauses).await?.0)
    }

    /// [`Self::probe`], and the wait a `429` refusing it asked for, which the
    /// foreground drain holds its next round back by (#5247).
    pub(in crate::sync) async fn probe_paced(
        &self,
        doc_ids: &[String],
        requests: &mut usize,
        pauses: &mut RateLimitPauses,
    ) -> Result<(HashMap<String, Probed>, Option<u64>), BodyPullError> {
        // The server refuses a batch naming an id twice.
        let mut ids: Vec<String> = Vec::new();
        for doc_id in doc_ids {
            if !ids.contains(doc_id) {
                ids.push(doc_id.clone());
            }
        }
        if ids.is_empty() {
            return Ok((HashMap::new(), None));
        }
        // A cursor of `0` is held too (#4315's empty body), so a resumed
        // first sync can tell it is still empty without re-pulling it. Each
        // document's epoch is captured with its cursor, before the request:
        // a purge after it leaves the answer to the purged body (#5356).
        //
        // One read on the pool for the whole chunk, not a writer hop per
        // document: a write-back busy on the writer starved the first sync's
        // probe for minutes with no request in flight (#5350).
        let cursors: Vec<(String, Option<i64>, Epoch)> = self
            .db
            .read(move |conn| {
                ids.into_iter()
                    .map(|doc_id| {
                        let cursor = store::read_cursor(conn, &crdt_cursor_scope(&doc_id))?
                            .and_then(|text| text.parse().ok());
                        let epoch = epoch::capture(conn, &doc_id).map_err(|error| {
                            StorageError::Failed {
                                what: error.to_string(),
                            }
                        })?;
                        Ok((doc_id, cursor, epoch))
                    })
                    .collect()
            })
            .await?;
        let notes: Vec<Json> = cursors
            .iter()
            .map(|(doc_id, cursor, _)| json!({ "noteId": doc_id, "since": cursor.unwrap_or(0) }))
            .collect();
        let body = loop {
            // Counted against the caller's per-pass budget like any other request.
            *requests += 1;
            let request = self
                .request("POST", "/sync/crdt/updates/batch")
                .json(&json!({ "notes": notes, "limit": CRDT_UPDATES_PAGE_LIMIT }))
                // No retries: a failed probe only means each document is pulled
                // through its own routes, so waiting through backoff buys nothing.
                .retry(RetryPolicy::never());
            match self.http.send_json::<Json>(request).await {
                Ok(body) => {
                    pauses.answered();
                    break body;
                }
                Err(error) => match pauses.take(&error) {
                    Some(wait) => self.wait(wait).await,
                    None => return Ok((HashMap::new(), error.rate_limit_wait_s())),
                },
            }
        };
        // An older server sends no `snapshotMeta` key at all, so an empty
        // answer there could hide a snapshot that pruned past the cursor.
        let metas = body.get("snapshotMeta").filter(|metas| metas.is_object());
        let revisions = self.held_revisions(&cursors).await?;
        let mut probed = HashMap::new();
        for (doc_id, cursor, epoch) in cursors {
            let page = read_update_page(&body, &doc_id);
            let since = cursor.unwrap_or(0);
            // A note the server left out of `notes` reads as an empty page,
            // and an entry `read_update_page` read tolerantly may have
            // dropped updates it could not parse: only a whole page stands in
            // for the updates GET.
            let entry = body.get("notes").and_then(|notes| notes.get(&doc_id));
            let whole_page = entry.is_some_and(|entry| {
                entry
                    .get("updates")
                    .and_then(Json::as_array)
                    .is_some_and(|updates| updates.len() == page.updates.len())
                    && entry.get("hasMore").is_some_and(Json::is_boolean)
            });
            // A log purged above `since` with no server snapshot to take
            // instead contradicts itself (§7.11 needs a baseline there).
            let floor = entry
                .and_then(|entry| entry.get("floor"))
                .and_then(Json::as_i64);
            let floor_held = page.snapshot_meta.is_some() || floor.is_some_and(|f| f <= since);
            // §7.11: an id absent from `snapshotMeta` (or null) has no server
            // snapshot. A present entry that does not parse is not "none".
            let meta_read = match metas.map(|metas| metas.get(&doc_id)) {
                Some(None | Some(Json::Null)) => true,
                Some(Some(_)) => page.snapshot_meta.is_some(),
                None => false,
            };
            let trusted = whole_page && meta_read && floor_held;
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
                        cursor >= meta.sequence_num
                            && revisions
                                .get(&doc_id)
                                .is_some_and(|held| held.as_deref() == Some(meta.revision.as_str()))
                    }
                };
            probed.insert(
                doc_id,
                Probed {
                    meta: page.snapshot_meta.clone(),
                    current,
                    answer: trusted.then_some(ProbeAnswer { since, epoch, page }),
                },
            );
        }
        Ok((probed, None))
    }

    /// The server revision this device holds for each document with a
    /// cursor, in one read on the pool: [`BodyPull::baseline_due`]'s read for
    /// a whole chunk. A NULL revision (§7.13.4) never equals a server token.
    async fn held_revisions(
        &self,
        cursors: &[(String, Option<i64>, Epoch)],
    ) -> Result<HashMap<String, Option<String>>, BodyPullError> {
        let ids: Vec<String> = cursors
            .iter()
            .filter(|(_, cursor, _)| cursor.is_some())
            .map(|(doc_id, _, _)| doc_id.clone())
            .collect();
        if ids.is_empty() {
            return Ok(HashMap::new());
        }
        Ok(self
            .db
            .read(move |conn| {
                ids.into_iter()
                    .map(|doc_id| {
                        let held = update_log::server_revision(conn, &doc_id)?;
                        Ok((doc_id, held))
                    })
                    .collect()
            })
            .await?)
    }
}
