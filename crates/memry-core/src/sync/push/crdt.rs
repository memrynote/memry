//! The CRDT half of the push wave, chapter 07 §7.4 and §7.4.2.
//!
//! **An update too large for the incremental route is never retired and never
//! sent.** The server keeps each update inline in one D1 row, so a client
//! sends at most [`MAX_UPDATE_PAYLOAD_CHARS`] of base64 per update
//! (desktop's `MAX_CRDT_UPDATE_PAYLOAD_CHARS`). The edit is already in the
//! local document, so a batch holding one goes to a **snapshot of the whole
//! document** instead, which holds every update queued before it was encoded:
//! the batch is acked when the server stored the snapshot and deferred when it
//! did not. Retiring would drop the user's edit, and sending would fail the
//! route and stall every row behind it.

use async_trait::async_trait;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde_json::{Value as Json, json};

use crate::api::errors::ApiError;
use crate::protocol::crdt_envelope::MAX_UPDATE_PAYLOAD_CHARS;
use crate::protocol::envelope::EnvelopeError;
use crate::protocol::http::RetryPolicy;
use crate::sync::outbox::{self, OutboxRow};

use super::{PushCoordinator, PushError, PushReport, now_ms, retry_at};

/// What a snapshot push for one document did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SnapshotFallbackOutcome {
    /// The server stored a snapshot of the whole document.
    Pushed,
    /// Nothing was stored, for this reason. The rows wait and try again.
    Refused(String),
}

/// Pushes one document as a snapshot, chapter 07 §7.7 and §7.13.2.
///
/// A seam because the live document and the snapshot gate belong to the
/// caller's session, not to the outbox. An `Err` is a failure the wave
/// reports like any other request's, a policy block or an offline network.
#[async_trait]
pub trait SnapshotFallback: Send + Sync {
    async fn push_snapshot(&self, doc_id: &str) -> Result<SnapshotFallbackOutcome, ApiError>;
}

const NO_FALLBACK: &str =
    "update too large for the incremental route and no snapshot push is set up";

impl PushCoordinator {
    /// One `POST /sync/crdt/updates` for one document (§7.2), or one snapshot
    /// when a row is too large to ride it.
    pub(super) async fn push_crdt(
        &self,
        doc_id: &str,
        rows: Vec<OutboxRow>,
        report: &mut PushReport,
    ) -> Result<(), PushError> {
        let attempts = rows.iter().map(|row| row.attempt_count).max().unwrap_or(0);
        let mut updates: Vec<String> = Vec::with_capacity(rows.len());
        let mut sent: Vec<i64> = Vec::with_capacity(rows.len());
        let mut oversized = false;
        for row in rows {
            let Some(update) = row.payload.as_deref() else {
                // A CRDT row with no bytes is the one row that cannot be
                // rebuilt from anywhere: the update is the change.
                self.retire_one(row.id, "crdt outbox row carries no update bytes")
                    .await?;
                report.retired += 1;
                continue;
            };
            match self.sealer.seal_crdt_update(doc_id, update) {
                Ok(packed) => {
                    let encoded = BASE64.encode(packed);
                    oversized |= encoded.len() > MAX_UPDATE_PAYLOAD_CHARS;
                    updates.push(encoded);
                    sent.push(row.id);
                }
                // Past the route's own cap: the same case, not an unsealable row.
                Err(EnvelopeError::ItemTooLarge { .. }) => {
                    oversized = true;
                    sent.push(row.id);
                }
                Err(error) => {
                    self.retire_one(row.id, &error.to_string()).await?;
                    report.retired += 1;
                }
            }
        }
        if sent.is_empty() {
            return Ok(());
        }
        if oversized {
            return self.push_as_snapshot(doc_id, sent, attempts, report).await;
        }

        let request = self
            .request("POST", "/sync/crdt/updates")
            // §7.10: every CRDT request is `maxRetries: 3`,
            // `baseDelayMs: 2000`, `retryOn429: false`.
            .retry(RetryPolicy::polled())
            .json(&json!({ "noteId": doc_id, "updates": updates }));
        let body: Json = self.http.send_json(request).await?;

        // §7.4: the server assigns the sequence numbers and answers
        // `{ sequences }`, one per update, in order. A row is acked against
        // the sequence assigned to that specific update, which is what lets
        // many rows for one document ride one wave; a short answer acks only
        // the prefix it covers.
        let assigned = body
            .get("sequences")
            .and_then(Json::as_array)
            .map(Vec::len)
            .unwrap_or(0);
        sent.truncate(assigned);
        report.accepted += sent.len();
        report.crdt_updates += sent.len();
        self.db.call(move |conn| outbox::ack(conn, &sent)).await?;
        Ok(())
    }

    /// Acks every row of the batch when the snapshot is stored, defers every
    /// row when it is not. All or none, so a peer never gets the rows around
    /// the large one without it.
    async fn push_as_snapshot(
        &self,
        doc_id: &str,
        ids: Vec<i64>,
        attempts: i64,
        report: &mut PushReport,
    ) -> Result<(), PushError> {
        let outcome = match &self.snapshot_fallback {
            Some(fallback) => fallback.push_snapshot(doc_id).await?,
            None => SnapshotFallbackOutcome::Refused(NO_FALLBACK.to_owned()),
        };
        match outcome {
            SnapshotFallbackOutcome::Pushed => {
                report.accepted += ids.len();
                report.crdt_updates += ids.len();
                self.db.call(move |conn| outbox::ack(conn, &ids)).await?;
            }
            SnapshotFallbackOutcome::Refused(reason) => {
                report.rejected += ids.len();
                let at = retry_at(now_ms(), attempts);
                self.db
                    .call(move |conn| outbox::defer(conn, &ids, &reason, Some(at)))
                    .await?;
            }
        }
        Ok(())
    }
}
