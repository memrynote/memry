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

use std::sync::Arc;

use async_trait::async_trait;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde_json::{Value as Json, json};

use crate::api::errors::ApiError;
use crate::crdt::snapshot_cadence::SnapshotRequests;
use crate::protocol::crdt_envelope::MAX_UPDATE_PAYLOAD_CHARS;
use crate::protocol::envelope::EnvelopeError;
use crate::protocol::http::RetryPolicy;
use crate::sync::admission::CrdtAdmission;
use crate::sync::crypto_batch::off_runtime;
use crate::sync::hardening::body_state::{self, PushEvent};
use crate::sync::outbox::{self, OutboxRow};

use super::{PushCoordinator, PushError, PushReport, now_ms, retry_at};

/// What a snapshot push for one document did, in the one class each outcome
/// belongs to (chapter 07 §7.4.2). The class decides how long the batch waits;
/// every class but [`Self::Pushed`] defers all of the batch's rows and retires
/// none.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SnapshotFallbackOutcome {
    /// The server stored a snapshot of the whole document.
    Pushed,
    /// Clears by itself (a pull still owed, a 5xx, a seal that failed): the
    /// retry waits at most [`DEFERRED_BACKOFF_MAX_MS`].
    Transient(String),
    /// The account is out of storage (413 `STORAGE_QUOTA_EXCEEDED`): only the
    /// user can clear it, so the retry climbs the full ladder.
    QuotaExceeded(String),
    /// The server refused this document for a reason of its own (a 4xx that is
    /// neither quota nor a pull owed): the full ladder, and the pass goes on.
    Rejected(String),
    /// Nothing changes until the document does (too large, an undecodable log,
    /// local-only, purged, empty): parked, with no retry until the next edit
    /// of the document queues a row ([`outbox::PARKED_UNTIL_EDIT`]).
    Parked(String),
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

/// The longest a transiently deferred batch waits before its next snapshot
/// try. Desktop's note-body outbox caps its backoff the same way
/// (`apps/desktop/src/main/sync/note-body-outbox.ts:31`).
pub const DEFERRED_BACKOFF_MAX_MS: i64 = 60_000;

const NO_FALLBACK: &str =
    "update too large for the incremental route and no snapshot push is set up";

/// How one document's batch ended, for the wave that tries each document once.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum BatchEnd {
    /// Sent and acked, or retired: nothing of it waits in the outbox.
    Done,
    /// Deferred or parked: the rest of this wave leaves the document alone.
    Deferred,
}

/// The driver's shared CRDT admission, and its snapshot requests: a document
/// whose updates the server stored wants a snapshot (`note-body-push.ts:96`).
pub(super) struct Pacing {
    admission: Arc<CrdtAdmission>,
    requests: Arc<SnapshotRequests>,
}

impl PushCoordinator {
    /// Paces every `/sync/crdt/updates` through `admission`, and requests a
    /// snapshot of each document it stored updates of.
    pub fn with_crdt_pacing(
        mut self,
        admission: Arc<CrdtAdmission>,
        requests: Arc<SnapshotRequests>,
    ) -> Self {
        self.crdt_pacing = Some(Pacing {
            admission,
            requests,
        });
        self
    }

    /// The documents the wave's next batch skips: those it already deferred,
    /// and every queued one while a `429` cooldown holds CRDT pushes, so the
    /// record rows behind them still go (`crdt-push-admission.ts`).
    pub(super) async fn skipped_docs(&self, deferred: &[String]) -> Result<Vec<String>, PushError> {
        if !self.cooling_down() {
            return Ok(deferred.to_vec());
        }
        Ok(self.db.call(|conn| outbox::crdt_docs(conn)).await?)
    }

    fn cooling_down(&self) -> bool {
        self.crdt_pacing
            .as_ref()
            .is_some_and(|pacing| pacing.admission.holding())
    }

    /// One `POST /sync/crdt/updates` for one document (§7.2), or one snapshot
    /// when a row is too large to ride it.
    pub(super) async fn push_crdt(
        &self,
        doc_id: &str,
        rows: Vec<OutboxRow>,
        report: &mut PushReport,
    ) -> Result<BatchEnd, PushError> {
        // A cooldown that began mid-wave: nothing is sealed or touched.
        if self.cooling_down() {
            return Ok(BatchEnd::Deferred);
        }
        let attempts = rows.iter().map(|row| row.attempt_count).max().unwrap_or(0);
        let mut updates: Vec<String> = Vec::with_capacity(rows.len());
        let mut sent: Vec<i64> = Vec::with_capacity(rows.len());
        let mut oversized = false;
        let retired_before = report.retired;
        let mut unsealed: Vec<(i64, Vec<u8>)> = Vec::with_capacity(rows.len());
        for row in rows {
            let Some(update) = row.payload else {
                // A CRDT row with no bytes is the one row that cannot be
                // rebuilt from anywhere: the update is the change.
                self.retire_rejected(doc_id, row.id, "crdt outbox row carries no update bytes")
                    .await?;
                report.retired += 1;
                continue;
            };
            unsealed.push((row.id, update));
        }
        for (id, sealed) in self.seal_updates(doc_id, unsealed).await? {
            match sealed {
                Ok(packed) => {
                    let encoded = BASE64.encode(packed);
                    oversized |= encoded.len() > MAX_UPDATE_PAYLOAD_CHARS;
                    updates.push(encoded);
                    sent.push(id);
                }
                // Past the route's own cap: the same case, not an unsealable row.
                Err(EnvelopeError::ItemTooLarge { .. }) => {
                    oversized = true;
                    sent.push(id);
                }
                Err(error) => {
                    self.retire_rejected(doc_id, id, &error.to_string()).await?;
                    report.retired += 1;
                }
            }
        }
        if report.retired > retired_before {
            // Dropped for good: only a snapshot of the whole document carries
            // them now (`note-body-outbox.ts:323`).
            if let Some(pacing) = &self.crdt_pacing {
                pacing.requests.request(doc_id, now_ms());
            }
        }
        if sent.is_empty() {
            return Ok(BatchEnd::Done);
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
        // A `429` cooldown holds every document's rows untouched, this wave
        // and until it ends (`crdt-push-admission.ts`).
        let _permit = match &self.crdt_pacing {
            Some(pacing) => match pacing.admission.admit().await {
                Ok(permit) => Some(permit),
                Err(_) => return Ok(BatchEnd::Deferred),
            },
            None => None,
        };
        self.mark(doc_id, PushEvent::Sent).await?;
        let body: Json = match self.http.send_json(request).await {
            Ok(body) => body,
            Err(error) => {
                if let Some(pacing) = &self.crdt_pacing {
                    pacing.admission.note(&error);
                }
                if let Err(record) = self.mark(doc_id, PushEvent::Failed).await {
                    eprintln!("memry-core: recording the failed body push of {doc_id}: {record:?}");
                }
                return Err(error.into());
            }
        };

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
        let stored = !sent.is_empty();
        let doc = doc_id.to_owned();
        self.db
            .call(move |conn| {
                let tx = conn.transaction().map_err(storage_failed)?;
                outbox::ack(&tx, &sent)?;
                if stored {
                    body_state::record(&tx, &doc, PushEvent::Confirmed, now_ms())?;
                }
                tx.commit().map_err(storage_failed)
            })
            .await?;
        if stored && let Some(pacing) = &self.crdt_pacing {
            pacing.requests.request(doc_id, now_ms());
        }
        Ok(BatchEnd::Done)
    }

    /// Seals one document's updates in one `spawn_blocking` hop, in row order.
    async fn seal_updates(
        &self,
        doc_id: &str,
        rows: Vec<(i64, Vec<u8>)>,
    ) -> Result<Vec<(i64, Result<Vec<u8>, EnvelopeError>)>, PushError> {
        let sealer = Arc::clone(&self.sealer);
        let doc_id = doc_id.to_owned();
        let sealed = off_runtime("sealing a document's crdt updates", move || {
            rows.into_iter()
                .map(|(id, update)| (id, sealer.seal_crdt_update(&doc_id, &update)))
                .collect()
        })
        .await?;
        Ok(sealed)
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
    ) -> Result<BatchEnd, PushError> {
        let outcome = match &self.snapshot_fallback {
            Some(fallback) => fallback.push_snapshot(doc_id).await?,
            None => SnapshotFallbackOutcome::Transient(NO_FALLBACK.to_owned()),
        };
        let now = now_ms();
        let doc = doc_id.to_owned();
        let (reason, at) = match outcome {
            SnapshotFallbackOutcome::Pushed => {
                report.accepted += ids.len();
                report.crdt_updates += ids.len();
                self.db
                    .call(move |conn| {
                        let tx = conn.transaction().map_err(storage_failed)?;
                        outbox::ack(&tx, &ids)?;
                        body_state::record(&tx, &doc, PushEvent::Snapshot, now)?;
                        tx.commit().map_err(storage_failed)
                    })
                    .await?;
                return Ok(BatchEnd::Done);
            }
            SnapshotFallbackOutcome::Transient(reason) => (
                reason,
                retry_at(now, attempts).min(now + DEFERRED_BACKOFF_MAX_MS),
            ),
            SnapshotFallbackOutcome::QuotaExceeded(reason)
            | SnapshotFallbackOutcome::Rejected(reason) => (reason, retry_at(now, attempts)),
            SnapshotFallbackOutcome::Parked(reason) => (reason, outbox::PARKED_UNTIL_EDIT),
        };
        report.rejected += ids.len();
        self.db
            .call(move |conn| {
                let tx = conn.transaction().map_err(storage_failed)?;
                outbox::defer(&tx, &ids, &reason, Some(at))?;
                body_state::record(&tx, &doc, PushEvent::Failed, now)?;
                tx.commit().map_err(storage_failed)
            })
            .await?;
        Ok(BatchEnd::Deferred)
    }

    /// Records what this wave did with `doc_id`'s body ([`body_state`]).
    /// §A.2's retire for one CRDT row, and its document's refusal in the same
    /// transaction: a refusal written after the retire commits is lost for
    /// good when its write fails, since the row it would retry from is gone.
    async fn retire_rejected(&self, doc_id: &str, id: i64, reason: &str) -> Result<(), PushError> {
        let (doc, reason) = (doc_id.to_owned(), reason.to_owned());
        self.db
            .call(move |conn| {
                let tx = conn.transaction().map_err(storage_failed)?;
                outbox::retire_in(&tx, &[id], &reason)?;
                body_state::record(&tx, &doc, PushEvent::Rejected, now_ms())?;
                tx.commit().map_err(storage_failed)
            })
            .await?;
        Ok(())
    }

    async fn mark(&self, doc_id: &str, event: PushEvent) -> Result<(), PushError> {
        let doc = doc_id.to_owned();
        let at = now_ms();
        self.db
            .call(move |conn| body_state::record(conn, &doc, event, at))
            .await?;
        Ok(())
    }
}

fn storage_failed(error: rusqlite::Error) -> crate::api::errors::StorageError {
    crate::api::errors::StorageError::Failed {
        what: error.to_string(),
    }
}
