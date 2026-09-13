//! The push wave, chapter 05 §5.6 and chapter 07 (T117, data-model §A.2, §C.3).
//!
//! The engine owns *when* to push; this owns *how*. Four rules shape it.
//!
//! **The payload is rebuilt from the live row at send time** — chapter 06
//! §6.5.2's P2, the obligation the chapter calls load-bearing. The outbox
//! carries a `(type, id)` key and no payload, and
//! [`sync_items::push_payload`]'s row is read here, inside the wave, after the
//! wave decided to send it. An outbox that froze the payload at enqueue
//! reintroduces §6.5.1's case-3c divergence *deterministically, not as a
//! race*.
//!
//! **A 5xx halves the batch; it never resends the same one** (§5.6).
//! [`RetryPolicy::push`] already encodes `retryOn5xx: false`, because
//! Cloudflare terminates an oversized `/sync/push` at the edge with an empty
//! 503 before any handler runs: there is no per-item verdict and an identical
//! resend fails identically. Retrying a push is also how a duplicate lands.
//! `PUSH_BATCH_SIZE` 100 halves down to `MIN_PUSH_BATCH_SIZE` 1, and
//! **the reduced size is held as a ceiling** — it is never raised again by
//! this coordinator, because the condition that produced it is a property of
//! the vault's row sizes rather than of one batch.
//!
//! **CRDT rows go first, grouped by document, then record rows**, so a body
//! edit can never land after its own note's delete (§A.2). The ordering is
//! [`outbox::next_batch`]'s; the routing is here, because the two go to
//! different routes with different retry ladders (§5.6 against §7.10).
//!
//! **A blocked policy parks without cost.** A `403`, a `426` or a `402` ends
//! the wave with no `attempt_count` touched and no row removed (§11.9), which
//! is why neither [`outbox::defer`] nor [`outbox::ack`] is reached on those
//! branches.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde_json::{Value as Json, json};

use crate::api::errors::{ApiError, StorageError, TransportError};
use crate::protocol::envelope::{EnvelopeError, SyncOperation};
use crate::protocol::http::{
    ApiRequest, Auth, DEFAULT_BASE_DELAY_MS, HttpClient, RetryPolicy, SYNC_TYPES_HEADER,
    VAULT_ID_HEADER,
};
use crate::protocol::types::Declaration;
use crate::storage::Db;
use crate::storage::repositories::sync_items::{self, SyncItemRow};

use super::engine::PushWave;
use super::outbox::{self, Batch, Collapsed, OutboxRow};

/// Chapter 05 §5.6, `apps/desktop/src/main/sync/engine/sync-context.ts:126-132`.
pub const PUSH_BATCH_SIZE: usize = 100;
pub const MIN_PUSH_BATCH_SIZE: usize = 1;
pub const MAX_PUSH_ITERATIONS: u32 = 50;

/// §5.7: a replay is rejected per item and does not fail the batch. The
/// server already holds a row no component of ours exceeds, so the queued row
/// has nothing left to say and is acked rather than retried forever.
pub const REASON_REPLAY_DETECTED: &str = "SYNC_REPLAY_DETECTED";
/// §5.8: delete wins over a concurrent write. Same reasoning.
pub const REASON_DELETE_WINS: &str = "SYNC_DELETE_WINS";

/// What a push failed with. A per-item rejection is **not** one of these: it
/// is a count in [`PushReport`].
#[derive(Debug, thiserror::Error)]
pub enum PushError {
    #[error("{source}")]
    Api {
        #[from]
        source: ApiError,
    },
    #[error("{source}")]
    Storage {
        #[from]
        source: StorageError,
    },
}

/// One record, read from the live row at send time (§6.5.2 P2).
#[derive(Debug, Clone)]
pub struct PendingRecord {
    pub operation: SyncOperation,
    pub row: SyncItemRow,
}

/// Seals what the wave sends.
///
/// A seam rather than a direct call to [`crate::protocol::envelope::encrypt`]
/// because sealing needs the vault key and this device's Ed25519 signing key,
/// and the key directory is not this task's. The wave's job is to decide
/// *what* to send and *what a failure means*, which is the same thing
/// whatever supplies the keys.
pub trait PushSealer: Send + Sync {
    /// One `PushItem` for `POST /sync/push`, chapter 04 §4.6 and §4.8.
    fn seal_record(&self, item: &PendingRecord) -> Result<Json, EnvelopeError>;

    /// One Yjs update as chapter 04 §4.11's packed envelope, base64.
    fn seal_crdt_update(&self, doc_id: &str, update: &[u8]) -> Result<Vec<u8>, EnvelopeError>;
}

/// What one wave did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PushReport {
    pub iterations: u32,
    /// Outbox rows the server accepted and this wave deleted.
    pub accepted: usize,
    /// Rows the server rejected per item and this wave left queued.
    pub rejected: usize,
    /// Rows that will never succeed and were acked locally (§A.2).
    pub retired: usize,
    pub crdt_updates: usize,
    /// The batch ceiling in force after the wave. Below
    /// [`PUSH_BATCH_SIZE`] iff a 5xx halved it.
    pub batch_ceiling: usize,
    /// The wave stopped because the ladder reached [`MIN_PUSH_BATCH_SIZE`]
    /// and a single item still drew a 5xx.
    pub halvings: u32,
}

/// The push half of a pass. One per vault.
pub struct PushCoordinator {
    http: Arc<HttpClient>,
    db: Db,
    sealer: Arc<dyn PushSealer>,
    declaration: Declaration,
    vault_id: Option<String>,
    /// §5.6's ceiling. Lowered by a 5xx and **never raised**.
    ceiling: AtomicUsize,
    halvings: AtomicUsize,
}

impl PushCoordinator {
    pub fn new(
        http: Arc<HttpClient>,
        db: Db,
        declaration: Declaration,
        sealer: Arc<dyn PushSealer>,
    ) -> Self {
        Self {
            http,
            db,
            sealer,
            declaration,
            vault_id: None,
            ceiling: AtomicUsize::new(PUSH_BATCH_SIZE),
            halvings: AtomicUsize::new(0),
        }
    }

    /// The `X-Memry-Vault-Id` header's value, when a vault is selected (§5.2).
    pub fn with_vault(mut self, vault_id: &str) -> Self {
        self.vault_id = Some(vault_id.to_owned());
        self
    }

    /// The batch size the next wave will claim. Starts at
    /// [`PUSH_BATCH_SIZE`] and only ever falls.
    pub fn batch_ceiling(&self) -> usize {
        self.ceiling.load(Ordering::Relaxed)
    }

    /// Drains the queue: at most [`MAX_PUSH_ITERATIONS`] batches, CRDT first.
    pub async fn drain_wave(&self) -> Result<PushReport, PushError> {
        let mut report = PushReport::default();
        for _ in 0..MAX_PUSH_ITERATIONS {
            let ceiling = self.batch_ceiling();
            let now = now_ms();
            let Some(batch) = self
                .db
                .call(move |conn| outbox::next_batch(conn, now, ceiling))
                .await?
            else {
                break;
            };
            report.iterations += 1;
            match batch {
                Batch::Crdt { doc_id, rows, .. } => {
                    self.push_crdt(&doc_id, rows, &mut report).await?
                }
                Batch::Records { items } => self.push_records(items, &mut report).await?,
            }
        }
        report.batch_ceiling = self.batch_ceiling();
        report.halvings = self.halvings.load(Ordering::Relaxed) as u32;
        Ok(report)
    }

    /// One `POST /sync/push`.
    async fn push_records(
        &self,
        items: Vec<Collapsed>,
        report: &mut PushReport,
    ) -> Result<(), PushError> {
        let mut sealed: Vec<Json> = Vec::with_capacity(items.len());
        let mut sent: Vec<Collapsed> = Vec::with_capacity(items.len());
        for item in items {
            match self.build(&item).await? {
                Ok(json) => {
                    sealed.push(json);
                    sent.push(item);
                }
                // §A.2: two rows retire forever rather than retrying — a row
                // whose payload cannot be parsed, and a row rejected as too
                // large. Both are acked locally with a recorded reason,
                // because a retry reproduces the same failure for ever.
                Err(reason) => {
                    let ids = item.ids();
                    report.retired += ids.len();
                    self.db
                        .call(move |conn| outbox::retire(conn, &ids, &reason))
                        .await?;
                }
            }
        }
        if sealed.is_empty() {
            return Ok(());
        }

        let request = self
            .request("POST", "/sync/push")
            .retry(RetryPolicy::push())
            .json(&json!({ "items": sealed }));
        let body: Json = match self.http.send_json(request).await {
            Ok(body) => body,
            Err(error) if is_retryable_5xx(&error) => return self.halve(error),
            Err(error) => return Err(error.into()),
        };

        let accepted = string_set(&body, "accepted");
        let now = now_ms();
        let mut acked: Vec<i64> = Vec::new();
        let mut deferred: Vec<(Vec<i64>, String, i64)> = Vec::new();
        for item in sent {
            let key = item.row.item_id.clone();
            if accepted.iter().any(|id| id == &key) {
                acked.extend(item.ids());
                continue;
            }
            let reason = rejection_reason(&body, &key);
            // §5.7 and §5.8: a replay and a delete-wins are the server saying
            // it already holds a row this one cannot improve on. Keeping the
            // row queued would retry it every pass for ever.
            if reason == REASON_REPLAY_DETECTED || reason == REASON_DELETE_WINS {
                acked.extend(item.ids());
            } else {
                let at = retry_at(now, item.row.attempt_count);
                deferred.push((item.ids(), reason, at));
            }
        }

        report.accepted += acked.len();
        report.rejected += deferred.len();
        self.db
            .call(move |conn| {
                outbox::ack(conn, &acked)?;
                for (ids, reason, at) in &deferred {
                    outbox::defer(conn, ids, reason, Some(*at))?;
                }
                Ok(())
            })
            .await?;
        Ok(())
    }

    /// Reads the live row and seals it, or names why the row retires.
    async fn build(&self, item: &Collapsed) -> Result<Result<Json, String>, PushError> {
        let item_type = item.row.item_type.clone();
        let item_id = item.row.item_id.clone();
        let row = self
            .db
            .call(move |conn| sync_items::load(conn, &item_type, &item_id))
            .await?;
        let Some(row) = row else {
            // §6.5.2 P2 has no answer for a queued key whose row is gone:
            // there is nothing live to rebuild from, and inventing a payload
            // is the freeze the rule forbids.
            return Ok(Err("no live sync_items row at send time".to_owned()));
        };
        let operation = match operation_of(&item.row) {
            Some(operation) => operation,
            None => return Ok(Err(format!("unknown outbox op `{}`", item.row.op))),
        };
        let pending = PendingRecord { operation, row };
        Ok(self.sealer.seal_record(&pending).map_err(|e| e.to_string()))
    }

    /// One `POST /sync/crdt/updates` for one document (§7.2).
    async fn push_crdt(
        &self,
        doc_id: &str,
        rows: Vec<OutboxRow>,
        report: &mut PushReport,
    ) -> Result<(), PushError> {
        let mut updates: Vec<String> = Vec::with_capacity(rows.len());
        let mut sent: Vec<i64> = Vec::with_capacity(rows.len());
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
                    updates.push(BASE64.encode(packed));
                    sent.push(row.id);
                }
                Err(error) => {
                    self.retire_one(row.id, &error.to_string()).await?;
                    report.retired += 1;
                }
            }
        }
        if updates.is_empty() {
            return Ok(());
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

    async fn retire_one(&self, id: i64, reason: &str) -> Result<(), PushError> {
        let reason = reason.to_owned();
        self.db
            .call(move |conn| outbox::retire(conn, &[id], &reason))
            .await?;
        Ok(())
    }

    /// §5.6's ladder: halve, hold the reduced size as a ceiling, and try
    /// again next iteration. At [`MIN_PUSH_BATCH_SIZE`] there is nothing left
    /// to halve, so the wave fails and §C.3 sends the pass to `Failed`.
    fn halve(&self, error: ApiError) -> Result<(), PushError> {
        let current = self.batch_ceiling();
        if current <= MIN_PUSH_BATCH_SIZE {
            return Err(error.into());
        }
        self.ceiling
            .store((current / 2).max(MIN_PUSH_BATCH_SIZE), Ordering::Relaxed);
        self.halvings.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }

    fn request(&self, method: &str, path: &str) -> ApiRequest {
        let mut request = ApiRequest::new(method, path)
            .auth(Auth::Session)
            // §5.3: negotiation is a header, not a query parameter, and the
            // CRDT routes sit behind the same middleware (§7.2).
            .header(SYNC_TYPES_HEADER, &self.declaration.header_value());
        if let Some(vault_id) = &self.vault_id {
            request = request.header(VAULT_ID_HEADER, vault_id);
        }
        request
    }
}

#[async_trait::async_trait]
impl PushWave for PushCoordinator {
    async fn pending(&self) -> Result<usize, ApiError> {
        let now = now_ms();
        self.db
            .call(move |conn| outbox::pending(conn, now))
            .await
            .map_err(local_failure)
    }

    async fn drain(&self) -> Result<(), ApiError> {
        match self.drain_wave().await {
            Ok(_) => Ok(()),
            Err(PushError::Api { source }) => Err(source),
            Err(PushError::Storage { source }) => Err(local_failure(source)),
        }
    }
}

/// The lossy half of the [`PushWave`] boundary.
///
/// `ApiError` has no storage variant and `crates/memry-core/src/api/errors.rs`
/// is not this module's to widen, so a local failure crosses as a transport
/// failure. It lands in the right state — the engine's `is_offline` matches
/// only [`TransportError::Offline`], so this reaches `Failed` and not
/// `Offline` — and the prefix keeps the log honest. [`PushError`] is the
/// undamaged type and is what a non-engine caller should use.
fn local_failure(error: StorageError) -> ApiError {
    ApiError::Transport {
        source: TransportError::Failed {
            what: format!("local storage: {error}"),
        },
    }
}

/// The outbox has one upsert op; chapter 04 §4.9 makes `update` the neutral
/// spelling, since a reader that sees no `operation` at all reads `update`.
fn operation_of(row: &OutboxRow) -> Option<SyncOperation> {
    match row.op.as_str() {
        outbox::OP_UPSERT => Some(SyncOperation::Update),
        outbox::OP_DELETE => Some(SyncOperation::Delete),
        _ => None,
    }
}

/// Chapter 00 §0.5's `INTERNAL_ERROR` row: 500, 502 and 503 are the only
/// statuses the table calls retryable, and they are the ones §5.6's ladder
/// answers. A `501` is a deployment gap (§0.6.1) and halving cannot help it.
fn is_retryable_5xx(error: &ApiError) -> bool {
    matches!(error, ApiError::Status { status, .. } if matches!(status, 500 | 502 | 503))
}

fn string_set(body: &Json, key: &str) -> Vec<String> {
    body.get(key)
        .and_then(Json::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Json::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// §5.11.1: `rejected` is `[{ id, reason }]`, per item, so a partially
/// accepted batch is normal and a client must read it rather than infer
/// success from the status code.
fn rejection_reason(body: &Json, id: &str) -> String {
    body.get("rejected")
        .and_then(Json::as_array)
        .and_then(|rows| {
            rows.iter()
                .find(|row| row.get("id").and_then(Json::as_str) == Some(id))
        })
        .and_then(|row| row.get("reason"))
        .and_then(Json::as_str)
        .unwrap_or("rejected without a reason")
        .to_owned()
}

/// Chapter 00 §0.6.1's ladder: `baseDelayMs * 2 ^ attempt`, zero-based, **no
/// jitter** — the client population is one device per account, so the
/// thundering-herd problem jitter solves does not arise and a deterministic
/// ladder is testable against a paused clock.
///
/// A rejected row must also leave the current wave: deferring it to *now*
/// makes it claimable again on the next iteration and burns the whole
/// 50-iteration budget re-sending an item the server has already refused.
fn retry_at(now_ms: i64, attempt_count: i64) -> i64 {
    let attempt = attempt_count.clamp(0, 16) as u32;
    now_ms + (DEFAULT_BASE_DELAY_MS as i64).saturating_mul(1i64 << attempt)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::outbox::RecordOp;

    #[test]
    fn only_the_three_internal_error_statuses_halve() {
        let status = |status| ApiError::Status {
            status,
            code: None,
            message: String::new(),
        };
        for retryable in [500, 502, 503] {
            assert!(is_retryable_5xx(&status(retryable)));
        }
        // §0.6.1: a 501 is a deployment gap, not a transient fault.
        for other in [400, 402, 404, 429, 501, 504] {
            assert!(!is_retryable_5xx(&status(other)));
        }
    }

    #[test]
    fn the_retry_ladder_is_base_times_two_to_the_attempt_with_no_jitter() {
        assert_eq!(retry_at(0, 0), DEFAULT_BASE_DELAY_MS as i64);
        assert_eq!(retry_at(0, 1), 2 * DEFAULT_BASE_DELAY_MS as i64);
        assert_eq!(retry_at(0, 2), 4 * DEFAULT_BASE_DELAY_MS as i64);
        assert!(retry_at(100, 40) > 100, "the shift is clamped, not wrapped");
    }

    #[test]
    fn an_upsert_is_an_update_on_the_wire() {
        let row = |op: RecordOp| OutboxRow {
            id: 1,
            item_type: "task".to_owned(),
            item_id: "t1".to_owned(),
            op: op.as_str().to_owned(),
            payload: None,
            enqueued_at: 0,
            attempt_count: 0,
            last_error: None,
            next_attempt_at: None,
        };
        assert_eq!(
            operation_of(&row(RecordOp::Upsert)),
            Some(SyncOperation::Update)
        );
        assert_eq!(
            operation_of(&row(RecordOp::Delete)),
            Some(SyncOperation::Delete)
        );
    }

    #[test]
    fn a_rejection_reason_is_read_per_item() {
        let body = json!({
            "accepted": ["a"],
            "rejected": [{"id": "b", "reason": REASON_REPLAY_DETECTED}],
        });
        assert_eq!(string_set(&body, "accepted"), vec!["a".to_owned()]);
        assert_eq!(rejection_reason(&body, "b"), REASON_REPLAY_DETECTED);
        assert_eq!(rejection_reason(&body, "c"), "rejected without a reason");
    }
}
