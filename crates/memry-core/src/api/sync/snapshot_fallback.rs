//! The snapshot push behind an update too large for the incremental route,
//! chapter 07 §7.4.2.
//!
//! The pass hands the push wave this seam: [`crate::sync::push::PushCoordinator`]
//! decides *that* a batch needs a snapshot, and this decides *whether one may
//! go*. The document is replayed from its durable log, which holds every
//! update the outbox does, so the snapshot covers the rows the wave then acks.
//! The gate is closed unless this pass's pull finished cleanly, because a
//! snapshot is destructive on the server (§7.7).

use std::sync::Arc;

use async_trait::async_trait;

use crate::api::errors::{ApiError, StorageError};
use crate::crdt::epoch;
use crate::crdt::registry::UpdateSink;
use crate::crdt::snapshots::SnapshotError;
use crate::crdt::{SnapshotGate, SnapshotOutcome, SnapshotPusher};
use crate::storage::Db;
use crate::sync::push::{SnapshotFallback, SnapshotFallbackOutcome};

// TODO(too-large notice): desktop tells the user a note is too large to sync
// (`emitNoteTooLarge`, `apps/desktop/src/main/sync/runtime.ts:663-671`). The
// core has no per-note sync status to carry that yet, so the reason sits on
// the deferred outbox row's `last_error` ([`crate::crdt::Refusal::TooLarge`]).
// The consumer is the per-note sync status the shells read once it exists.
pub(super) struct PassSnapshots {
    pub(super) pusher: SnapshotPusher,
    pub(super) db: Db,
    pub(super) device_id: String,
    /// §7.13.2 condition 1 for this pass: the pull ran to its end with nothing
    /// refused, dropped or left undecoded.
    pub(super) pull_completed_clean: bool,
    pub(super) purged_documents: Vec<String>,
}

#[async_trait]
impl SnapshotFallback for PassSnapshots {
    async fn push_snapshot(&self, doc_id: &str) -> Result<SnapshotFallbackOutcome, ApiError> {
        let id = doc_id.to_owned();
        let device_id = self.device_id.clone();
        let opened = self
            .db
            .call(move |conn| {
                // The replay is durable, so the sink sees nothing.
                let sink: UpdateSink = Arc::new(|_, _| {});
                Ok(epoch::open_for_write(conn, &device_id, &id, sink)
                    .map_err(|error| error.to_string()))
            })
            .await
            .map_err(local)?;
        // A log row that will not decode is this document's problem: its batch
        // waits, and the records and other documents behind it still go.
        let document = match opened {
            Ok(document) => document,
            Err(reason) => {
                return Ok(SnapshotFallbackOutcome::Refused(format!(
                    "could not replay the document's update log: {reason}"
                )));
            }
        };
        let gate = SnapshotGate {
            pull_completed_clean: self.pull_completed_clean,
            purged: self.purged_documents.iter().any(|purged| purged == doc_id),
        };
        match self
            .pusher
            .push(&document, gate, crate::api::tasks_write::now_ms())
            .await
        {
            Ok(SnapshotOutcome::Pushed { .. }) => Ok(SnapshotFallbackOutcome::Pushed),
            Ok(SnapshotOutcome::Refused(refusal)) => Ok(SnapshotFallbackOutcome::Refused(
                refusal.reason().to_owned(),
            )),
            Err(SnapshotError::Rejected { reason }) => Ok(SnapshotFallbackOutcome::Refused(reason)),
            // Local failures before any request, an undecodable update or a
            // seal that failed: this document's batch waits (chapter 07
            // §7.4.2). Failing the wave would stall every record behind it,
            // because CRDT rows are claimed first.
            Err(error @ (SnapshotError::Crdt { .. } | SnapshotError::Seal { .. })) => {
                Ok(SnapshotFallbackOutcome::Refused(error.to_string()))
            }
            // The server answered and said no: the rows wait instead of
            // failing every pass at this batch. Everything else, an offline
            // network or a policy block, fails the wave like any request.
            Err(SnapshotError::Api {
                source: error @ ApiError::Status { status, .. },
            }) if status == 413 || status >= 500 => {
                Ok(SnapshotFallbackOutcome::Refused(error.to_string()))
            }
            Err(SnapshotError::Api { source }) => Err(source),
            Err(SnapshotError::Storage { source }) => Err(local(source)),
        }
    }
}

fn local(error: StorageError) -> ApiError {
    ApiError::Storage {
        what: error.to_string(),
    }
}
