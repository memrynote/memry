//! The batched snapshot push, `POST /sync/crdt/snapshot/batch` (chapter 07
//! §7.3, §7.4, #1857).
//!
//! One request per note costs a seeding vault one round trip per body. The
//! batch route takes up to [`MAX_SNAPSHOT_BATCH_ENTRIES`] of the same entries
//! the single-note route takes, with the same destructive consequence per note.
//! So every document passes [`SnapshotPusher::prepare`], the whole of §7.13.2,
//! before it can ride a batch. A document with unmerged remote state is refused
//! there and never reaches the wire.
//!
//! Two answers send the documents down the single-note route instead, as
//! desktop's `crdt-snapshot-batch.ts` does:
//!
//! - **404**: a server older than the route. Latched on the pusher, so the rest
//!   of the session pays no further 404s.
//! - **413**: the aggregate body was too large, which names no note. The
//!   single-note route can tell which one is.

use std::sync::atomic::Ordering;

use serde_json::{Value as Json, json};

use crate::api::errors::ApiError;
use crate::protocol::http::RetryPolicy;

use super::registry::Document;
use super::snapshots::{
    CRDT_SNAPSHOT_NOT_COVERED, Prepared, SnapshotError, SnapshotGate, SnapshotOutcome,
    SnapshotPusher,
};

/// §7.3: snapshots per batch push, 1 to 50.
pub const MAX_SNAPSHOT_BATCH_ENTRIES: usize = 50;

const BATCH_PATH: &str = "/sync/crdt/snapshot/batch";

/// One document's outcome, keyed by its id.
pub type BatchOutcome = (String, Result<SnapshotOutcome, SnapshotError>);

impl SnapshotPusher {
    /// [`SnapshotPusher::push`] for many documents, in batches of
    /// [`MAX_SNAPSHOT_BATCH_ENTRIES`]. Answers once per document, in input
    /// order. A failure for one document never fails the others.
    pub async fn push_batch(
        &self,
        documents: &[(&Document, SnapshotGate)],
        now_ms: i64,
    ) -> Vec<BatchOutcome> {
        // `None` until the request carrying the document answers.
        let mut outcomes: Vec<(String, Option<Result<SnapshotOutcome, SnapshotError>>)> =
            Vec::with_capacity(documents.len());
        let mut ready = Vec::new();
        for (document, gate) in documents {
            let early = match self.prepare(document, *gate).await {
                Ok(Ok(prepared)) => {
                    ready.push((outcomes.len(), prepared));
                    None
                }
                Ok(Err(refusal)) => Some(Ok(SnapshotOutcome::Refused(refusal))),
                Err(error) => Some(Err(error)),
            };
            outcomes.push((document.id().to_owned(), early));
        }

        let mut ready = ready.into_iter().peekable();
        while ready.peek().is_some() {
            let chunk: Vec<(usize, Prepared)> =
                ready.by_ref().take(MAX_SNAPSHOT_BATCH_ENTRIES).collect();
            for (at, outcome) in self.push_chunk(chunk, now_ms).await {
                outcomes[at].1 = Some(outcome);
            }
        }
        outcomes
            .into_iter()
            .map(|(id, outcome)| (id, outcome.expect("every prepared document is answered")))
            .collect()
    }

    async fn push_chunk(
        &self,
        chunk: Vec<(usize, Prepared)>,
        now_ms: i64,
    ) -> Vec<(usize, Result<SnapshotOutcome, SnapshotError>)> {
        if self.batch_unsupported.load(Ordering::Relaxed) {
            return self.push_one_by_one(chunk, now_ms).await;
        }
        let entries: Vec<&Json> = chunk.iter().map(|(_, p)| &p.payload).collect();
        let request = self
            .request("POST", BATCH_PATH)
            // §7.10, as for the single-note route.
            .retry(RetryPolicy::polled())
            .json(&json!({ "snapshots": entries }));
        let body: Json = match self.http.send_json(request).await {
            Ok(body) => body,
            Err(ApiError::Status { status: 404, .. }) => {
                self.batch_unsupported.store(true, Ordering::Relaxed);
                return self.push_one_by_one(chunk, now_ms).await;
            }
            Err(ApiError::Status { status: 413, .. }) => {
                return self.push_one_by_one(chunk, now_ms).await;
            }
            Err(error) => {
                return chunk
                    .into_iter()
                    .map(|(at, _)| (at, Err(error.clone().into())))
                    .collect();
            }
        };

        let results = body
            .get("results")
            .and_then(Json::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default();
        let mut out = Vec::with_capacity(chunk.len());
        for (at, prepared) in chunk {
            let answer = results
                .iter()
                .find(|r| r.get("noteId").and_then(Json::as_str) == Some(&prepared.doc_id));
            out.push((at, self.apply_result(prepared, answer, now_ms).await));
        }
        out
    }

    async fn apply_result(
        &self,
        prepared: Prepared,
        answer: Option<&Json>,
        now_ms: i64,
    ) -> Result<SnapshotOutcome, SnapshotError> {
        // A document the response never mentioned did not land. Reporting it
        // as stored would drop a body with nothing left to retry it.
        let Some(answer) = answer else {
            return Err(ApiError::MalformedResponse {
                path: BATCH_PATH.to_owned(),
                what: format!("no result for {}", prepared.doc_id),
            }
            .into());
        };
        if answer.get("accepted").and_then(Json::as_bool) == Some(true) {
            return self.settle(prepared, answer, now_ms).await;
        }
        let reason = answer
            .get("reason")
            .and_then(Json::as_str)
            .unwrap_or("rejected")
            .to_owned();
        if reason.starts_with(CRDT_SNAPSHOT_NOT_COVERED) {
            return self.not_covered(prepared.doc_id).await;
        }
        Err(SnapshotError::Rejected { reason })
    }

    async fn push_one_by_one(
        &self,
        chunk: Vec<(usize, Prepared)>,
        now_ms: i64,
    ) -> Vec<(usize, Result<SnapshotOutcome, SnapshotError>)> {
        let mut out = Vec::with_capacity(chunk.len());
        for (at, prepared) in chunk {
            out.push((at, self.push_prepared(prepared, now_ms).await));
        }
        out
    }
}
