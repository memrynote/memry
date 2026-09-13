//! Snapshot push and local prune, chapter 07 §7.5 – §7.8, §7.12 and §7.13
//! (the client obligation T041 wrote).
//!
//! Four rules carry this file and each one loses data if it is dropped:
//!
//! 1. **A snapshot is destructive** (§7.7): storing one makes the server
//!    delete every device's `crdt_updates` row at or below the watermark. So
//!    the gate of §7.13.2 is a **MUST**, not a heuristic, and
//!    [`SnapshotGate::check`] is the only door to [`SnapshotPusher::push`].
//! 2. **A snapshot is `encode_state_as_update_v1(&StateVector::default())` and
//!    nothing else** (chapter 12 §12.5.1). The bytes come from
//!    [`Document::encode_state`], which is that call; assembling a document
//!    from named roots drops every root this build has not heard of.
//! 3. **The watermark is the server's and it does not move** (§7.6). A second
//!    snapshot for a document reuses the sequence number the first one took,
//!    because a client-uploaded snapshot carries no causal metadata proving it
//!    already contains every server update above the prior watermark. The
//!    client therefore stores the sequence number **the response gave it** and
//!    never one it computed, and [`stable_watermark`] refuses to let a stored
//!    watermark walk forward.
//! 4. **A pushed snapshot stores a NULL local revision** (§7.13.4, until
//!    #2187). The push response answers `{ sequenceNum }` and not `revision`,
//!    and an invented token can collide with a real one and suppress a
//!    baseline the client needed.
//!
//! **The prune here is the local one.** §7.7 is explicit that a client does no
//! pruning of the *server's* log — the server does that itself, between the
//! store and the broadcast (§7.12). What this file prunes is this device's own
//! server-namespace rows at or below the watermark, which the snapshot now
//! contains and [`super::update_log::load_plan`] would never read again.

use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use rusqlite::{Connection, params};
use serde_json::{Value as Json, json};
use yrs::ReadTxn as _;

use crate::api::errors::{ApiError, StorageError};
use crate::protocol::envelope::EnvelopeError;
use crate::protocol::http::{
    ApiRequest, Auth, HttpClient, RetryPolicy, SYNC_TYPES_HEADER, VAULT_ID_HEADER,
};
use crate::protocol::types::Declaration;
use crate::storage::Db;

use super::errors::CrdtError;
use super::registry::Document;
use super::update_log::{self, Namespace};

/// Seals one full-state encode as chapter 04 §4.11's packed envelope.
///
/// A seam rather than a direct call into `crdt_envelope::pack`, for the same
/// reason [`crate::sync::push::PushSealer`] is one: sealing needs the vault
/// key and this device's Ed25519 signing key, and the key directory is not
/// this module's. **There is no separate snapshot envelope** (§7.11) — this is
/// the identical packing an update gets.
pub trait SnapshotSealer: Send + Sync {
    fn seal_snapshot(&self, doc_id: &str, state: &[u8]) -> Result<Vec<u8>, EnvelopeError>;
}

/// Why §7.13.2 refused a document.
///
/// Distinct variants rather than a bool, because the three conditions clear in
/// completely different ways: unmerged state clears on the next clean pull, a
/// local-only document never clears, and an empty encode clears on the first
/// edit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    /// Condition 1: the last pull ended holding debt — a stop-at-gap, an
    /// unresolvable signer, or a document still missing an antecedent.
    UnmergedRemoteState,
    /// Condition 2: the document is local-only.
    LocalOnly,
    /// Condition 2: the document was purged.
    Purged,
    /// Condition 3: the encoded state is empty.
    EmptyState,
}

impl Refusal {
    pub fn reason(&self) -> &'static str {
        match self {
            Self::UnmergedRemoteState => "the document still holds unmerged remote state",
            Self::LocalOnly => "the document is local-only",
            Self::Purged => "the document was purged",
            Self::EmptyState => "the encoded state is empty",
        }
    }
}

/// The two facts §7.13.2 needs that a `yrs` document cannot answer for itself.
///
/// `has_missing_updates` covers the third — a document holding an update whose
/// antecedent never arrived — and [`SnapshotGate::check`] reads it directly,
/// so a caller cannot forget to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct SnapshotGate {
    /// §7.13.2 condition 1, the half only the pull loop knows: the document's
    /// last pull completed with no stopped-at-gap and no unresolvable signer.
    /// Desktop's equivalent is `hasUnmergedRemoteCrdtState`, true for any
    /// document whose session ended holding debt.
    pub pull_completed_clean: bool,
    /// §7.13.2 condition 2.
    pub local_only: bool,
    /// §7.13.2 condition 2.
    pub purged: bool,
}

impl SnapshotGate {
    /// The gate a document that has merged everything and lives on the server
    /// passes.
    pub fn clean() -> Self {
        Self {
            pull_completed_clean: true,
            local_only: false,
            purged: false,
        }
    }

    /// §7.13.2, all three conditions. `Ok(None)` means the push may proceed.
    ///
    /// The encoded state is returned alongside rather than recomputed by the
    /// caller: condition 3 is about the very bytes that get pushed, and
    /// encoding twice invites a document that changed in between passing the
    /// gate on one encode and shipping another.
    pub fn check(&self, document: &Document) -> Result<Result<Vec<u8>, Refusal>, CrdtError> {
        if !self.pull_completed_clean || document.has_missing_updates()? {
            return Ok(Err(Refusal::UnmergedRemoteState));
        }
        if self.local_only {
            return Ok(Err(Refusal::LocalOnly));
        }
        if self.purged {
            return Ok(Err(Refusal::Purged));
        }
        // Condition 3, read as "this document has no content", which is the
        // state vector being empty rather than the encode being zero bytes:
        // `encode_state_as_update_v1` of an untouched document is two zero
        // varints, not an empty run, so a length test never fires and every
        // freshly opened document would pass a gate whose whole job is to
        // stop exactly that.
        if document.read(|txn| txn.state_vector().is_empty())? {
            return Ok(Err(Refusal::EmptyState));
        }
        // Chapter 12 §12.5.1: the full-state encode, and never a walk of named
        // roots.
        Ok(Ok(document.encode_state()?))
    }
}

/// What [`SnapshotPusher::push`] did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SnapshotOutcome {
    /// §7.13.2 refused. **The endpoint was not called.** §7.13.2's fallback is
    /// open to the caller: the same full state MAY go to
    /// `POST /sync/crdt/updates`, which prunes nothing.
    Refused(Refusal),
    /// Stored server-side at `sequence_num`, which is the **stable** watermark
    /// of §7.6 and not necessarily the document's highest sequence.
    Pushed {
        sequence_num: i64,
        /// Local server-namespace update rows this device deleted because the
        /// stored snapshot now contains them.
        pruned: usize,
    },
}

#[derive(Debug, thiserror::Error)]
pub enum SnapshotError {
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
    #[error("{source}")]
    Crdt {
        #[from]
        source: CrdtError,
    },
    #[error("could not seal the snapshot: {source}")]
    Seal {
        #[from]
        source: EnvelopeError,
    },
}

/// The snapshot writer. One per vault.
pub struct SnapshotPusher {
    http: Arc<HttpClient>,
    db: Db,
    sealer: Arc<dyn SnapshotSealer>,
    declaration: Declaration,
    vault_id: Option<String>,
}

impl SnapshotPusher {
    pub fn new(
        http: Arc<HttpClient>,
        db: Db,
        sealer: Arc<dyn SnapshotSealer>,
        declaration: Declaration,
    ) -> Self {
        Self {
            http,
            db,
            sealer,
            declaration,
            vault_id: None,
        }
    }

    pub fn with_vault(mut self, vault_id: &str) -> Self {
        self.vault_id = Some(vault_id.to_owned());
        self
    }

    /// Gate, encode, seal, `POST /sync/crdt/snapshot`, store, prune.
    ///
    /// In that order and no other. The gate runs before the encode so a
    /// refused document never pays for one, and the store runs before the
    /// prune so a kill between them leaves rows that are merely redundant
    /// rather than rows the snapshot never absorbed.
    pub async fn push(
        &self,
        document: &Document,
        gate: SnapshotGate,
        now_ms: i64,
    ) -> Result<SnapshotOutcome, SnapshotError> {
        let state = match gate.check(document)? {
            Ok(state) => state,
            Err(refusal) => return Ok(SnapshotOutcome::Refused(refusal)),
        };
        let doc_id = document.id().to_owned();
        let packed = self.sealer.seal_snapshot(&doc_id, &state)?;

        // §7.3's field name, §7.4's request shape for the sibling route: one
        // document per call, the payload base64 of the same packed envelope an
        // update travels in (§7.11).
        let request = self
            .request("POST", "/sync/crdt/snapshot")
            // §7.10: every CRDT request is `maxRetries: 3`, `baseDelayMs:
            // 2000`, `retryOn429: false`.
            .retry(RetryPolicy::polled())
            .json(&json!({ "noteId": doc_id, "snapshot": BASE64.encode(&packed) }));
        let body: Json = self.http.send_json(request).await?;

        // §7.4: the server assigns the sequence number and a client never
        // proposes one. §7.6: on a document that already had a snapshot this
        // is the *original* watermark coming back, not a new one.
        let answered = body.get("sequenceNum").and_then(Json::as_i64);

        let stored_doc_id = doc_id.clone();
        let pruned = self
            .db
            .call(move |conn| store_pushed_snapshot(conn, &stored_doc_id, &state, answered, now_ms))
            .await?;

        Ok(SnapshotOutcome::Pushed {
            sequence_num: pruned.0,
            pruned: pruned.1,
        })
    }

    fn request(&self, method: &str, path: &str) -> ApiRequest {
        let mut request = ApiRequest::new(method, path)
            .auth(Auth::Session)
            // §7.2: the CRDT routes sit behind the same sync-types middleware
            // as the record routes.
            .header(SYNC_TYPES_HEADER, &self.declaration.header_value());
        if let Some(vault_id) = &self.vault_id {
            request = request.header(VAULT_ID_HEADER, vault_id);
        }
        request
    }
}

/// §7.6, applied to the local row: the watermark a document's snapshot sits at
/// **never moves forward** once one exists.
///
/// `answered` is what the push response carried, `existing` what this device
/// already had. A server obeying §7.6 answers `existing` again, so the two
/// agree and the `min` is a no-op; a server that answered higher would, if
/// believed, make [`super::update_log::load_plan`] skip every incremental
/// between the two numbers forever. There is no reading of this function under
/// which the client loses an update.
pub fn stable_watermark(existing: Option<i64>, answered: Option<i64>) -> i64 {
    match (existing, answered) {
        (Some(existing), Some(answered)) => existing.min(answered),
        (Some(existing), None) => existing,
        (None, Some(answered)) => answered,
        // A server that answered no sequence number at all, on a document that
        // had no snapshot: the snapshot is stored at 0, which keeps every
        // server update pullable rather than hiding a prefix of them.
        (None, None) => 0,
    }
}

/// Stores the pushed snapshot and prunes the local rows it absorbed.
///
/// One transaction. A kill between the two would otherwise leave a pruned log
/// with no snapshot, which is the one shape that loses body state.
///
/// Returns the watermark written and how many rows were pruned.
fn store_pushed_snapshot(
    conn: &Connection,
    doc_id: &str,
    state: &[u8],
    answered: Option<i64>,
    now_ms: i64,
) -> Result<(i64, usize), StorageError> {
    let txn = conn.unchecked_transaction().map_err(failed)?;

    let existing = update_log::snapshot(&txn, Namespace::Server, doc_id)
        .map_err(crdt_to_storage)?
        .map(|row| row.last_seq);
    let watermark = stable_watermark(existing, answered);

    // §7.13.4: NULL, never an invented token. The push response carries no
    // `revision`, and a made-up one can collide with a server revision and
    // suppress a baseline this client needed.
    update_log::put_server_snapshot(&txn, doc_id, state, watermark, None, now_ms)
        .map_err(crdt_to_storage)?;

    let pruned = txn
        .execute(
            "DELETE FROM yjs_updates WHERE doc_id = ?1 AND seq <= ?2",
            params![Namespace::Server.row_id(doc_id), watermark],
        )
        .map_err(failed)?;

    txn.commit().map_err(failed)?;
    Ok((watermark, pruned))
}

fn crdt_to_storage(error: CrdtError) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_watermark_never_walks_forward_once_a_snapshot_exists() {
        // §7.6: the server reuses the existing sequence number, so the two
        // agree and nothing moves.
        assert_eq!(stable_watermark(Some(12), Some(12)), 12);
        // A server that answered higher is not believed: believing it would
        // hide updates 13..=30 from `load_plan` forever.
        assert_eq!(stable_watermark(Some(12), Some(30)), 12);
        // The first snapshot for a document takes whatever the server gave it.
        assert_eq!(stable_watermark(None, Some(7)), 7);
        // A server that answered nothing, on a fresh document, keeps every
        // update pullable.
        assert_eq!(stable_watermark(None, None), 0);
        assert_eq!(stable_watermark(Some(4), None), 4);
    }

    #[test]
    fn every_refusal_carries_its_own_reason() {
        let reasons: Vec<&str> = [
            Refusal::UnmergedRemoteState,
            Refusal::LocalOnly,
            Refusal::Purged,
            Refusal::EmptyState,
        ]
        .iter()
        .map(Refusal::reason)
        .collect();
        // Four conditions, four explanations: §7.13.2's three clear in
        // different ways and a collapsed message tells the user the wrong one.
        let mut unique = reasons.clone();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(unique.len(), reasons.len());
    }
}
