//! The driver's snapshot pushes, chapter 07 §7.13 (`crdt-snapshot-scheduler.ts`,
//! `crdt-snapshot-batch.ts`).
//!
//! The push wave requests a snapshot of every document whose updates the server
//! stored ([`SnapshotRequests`]). The shell polls [`SyncDriver::snapshots_due`]
//! on a short timer and runs a pass when one is; the pass ends with
//! [`SyncDriver::push_due_snapshots`], so the gate reads the pull that just ran
//! (the engine's [`crate::sync::engine::PullSink`] records it). The same poll
//! starts a push once a `429` cooldown that held CRDT rows ends.
//! At shutdown [`SyncDriver::final_snapshots`] pushes every pending one.
//!
//! A snapshot is destructive on the server (§7.7), so every push runs under the
//! vault's pass gate, never beside a pull, and passes [`SnapshotPusher::prepare`]'s
//! durable checks. Requests go in batches of [`MAX_SNAPSHOT_BATCH_ENTRIES`], each
//! admitted through the driver's [`crate::sync::admission::CrdtAdmission`].

use tokio::time::Instant;

use crate::api::sync::snapshot_fallback::classify;
use crate::crdt::snapshot_batch::MAX_SNAPSHOT_BATCH_ENTRIES;
use crate::sync::hardening::body_state::{self, PushEvent};
use crate::sync::push::SnapshotFallbackOutcome;

use super::SyncDriver;

/// What one snapshot push round did.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct SnapshotRound {
    pub pushed: usize,
    /// Asked again: a pull still owed, a transient failure, a `429`, or the
    /// deadline.
    pub requeued: usize,
    /// Dropped until the document's next stored update: refused or rejected.
    pub dropped: usize,
}

impl SyncDriver {
    /// Whether a push is due at `now_ms`: a snapshot (30 s quiet, 120 s at
    /// most), or CRDT rows a `429` cooldown held, now that it ended.
    pub fn snapshots_due(&self, now_ms: i64) -> bool {
        self.snapshot_requests.any_due(now_ms) || self.admission.take_resume()
    }

    /// Pushes the snapshots due at `now_ms`. Run after a pass, under its gate.
    /// None while paused.
    pub async fn push_due_snapshots(&self, now_ms: i64) -> SnapshotRound {
        if self.is_paused() {
            return SnapshotRound::default();
        }
        let due = self.snapshot_requests.take_due(now_ms);
        self.push_snapshots(due, None).await
    }

    /// Shutdown: every pending snapshot, due or not, batch by batch until
    /// `deadline`. What the deadline cuts off is requested again, unsent.
    pub async fn final_snapshots(&self, deadline: Instant) -> SnapshotRound {
        let pending = self.snapshot_requests.take_all();
        self.push_snapshots(pending, Some(deadline)).await
    }

    async fn push_snapshots(&self, docs: Vec<String>, deadline: Option<Instant>) -> SnapshotRound {
        let mut round = SnapshotRound::default();
        if docs.is_empty() {
            return round;
        }
        let _gate = self.engine.hold_gate().await;
        let now = crate::sync::pull::now_ms();
        let mut chunks = docs.chunks(MAX_SNAPSHOT_BATCH_ENTRIES);
        while let Some(chunk) = chunks.next() {
            let cut = self.is_paused() || deadline.is_some_and(|at| Instant::now() >= at);
            let admitted = if cut {
                None
            } else {
                self.admission.admit().await.ok()
            };
            let Some(_permit) = admitted else {
                // A pause, a deadline or a `429` cooldown: every document left
                // waits.
                for doc_id in chunk.iter().chain(chunks.flatten()) {
                    self.snapshot_requests.request(doc_id, now);
                    round.requeued += 1;
                }
                break;
            };
            self.push_chunk(chunk, now, &mut round).await;
        }
        round
    }

    async fn push_chunk(&self, chunk: &[String], now: i64, round: &mut SnapshotRound) {
        let mut documents = Vec::with_capacity(chunk.len());
        for doc_id in chunk {
            match self.snapshots.replay(doc_id).await {
                Ok(Ok(document)) => documents.push(document),
                Ok(Err(outcome)) => self.settle(doc_id, Ok(outcome), now, round),
                Err(error) => self.settle(doc_id, Err(error), now, round),
            }
        }
        let pairs: Vec<_> = documents
            .iter()
            .map(|(document, opened_at)| {
                (&**document, *opened_at, self.snapshots.gate(document.id()))
            })
            .collect();
        let mut stored = Vec::new();
        for (doc_id, outcome) in self.snapshots.pusher.push_batch(&pairs, now).await {
            if let Err(crate::crdt::snapshots::SnapshotError::Api { source }) = &outcome {
                self.admission.note(source);
            }
            let outcome = classify(outcome);
            if matches!(outcome, Ok(SnapshotFallbackOutcome::Pushed)) {
                stored.push(doc_id.to_string());
            }
            self.settle(&doc_id, outcome, now, round);
        }
        self.record_stored(stored, now).await;
    }

    /// A stored snapshot confirms the body and clears a refusal ([`body_state`]).
    async fn record_stored(&self, docs: Vec<String>, now: i64) {
        if docs.is_empty() {
            return;
        }
        let recorded = self
            .db
            .call(move |conn| {
                docs.iter()
                    .try_for_each(|doc| body_state::record(conn, doc, PushEvent::Snapshot, now))
            })
            .await;
        if let Err(error) = recorded {
            eprintln!("memry-core: recording the stored snapshots failed: {error}");
        }
    }

    fn settle(
        &self,
        doc_id: &str,
        outcome: Result<SnapshotFallbackOutcome, crate::api::errors::ApiError>,
        now: i64,
        round: &mut SnapshotRound,
    ) {
        match outcome {
            Ok(SnapshotFallbackOutcome::Pushed) => round.pushed += 1,
            // A pull still owed, a 5xx, a seal, the network, a `429`, a session
            // the server refused: the document asks again.
            Ok(SnapshotFallbackOutcome::Transient(_)) => {
                self.snapshot_requests.request(doc_id, now);
                round.requeued += 1;
            }
            Err(error) => {
                eprintln!("memry-core: the snapshot of {doc_id} failed, asking again: {error}");
                self.snapshot_requests.request(doc_id, now);
                round.requeued += 1;
            }
            // Parked, rejected, out of quota: its next stored update asks again.
            Ok(outcome) => {
                eprintln!("memry-core: the snapshot of {doc_id} was not pushed: {outcome:?}");
                round.dropped += 1;
            }
        }
    }
}
