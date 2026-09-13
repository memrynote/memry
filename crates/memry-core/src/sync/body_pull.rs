//! Pulling note and journal **bodies** down, chapter 07 §7.8 – §7.11.
//!
//! This is the downward half of the CRDT feed, and without it a device that
//! syncs perfectly still shows every note empty: a record push for a body edit
//! carries `content: null`, so the record feed (chapter 05) carries note
//! *metadata* and nothing else. `yjs_updates` fills from here or it does not
//! fill at all.
//!
//! Four rules, each load-bearing:
//!
//! - **The baseline rule** (§7.8). Fetch the snapshot first when the cursor is
//!   `0`, or when the server advertises a snapshot ahead of the cursor whose
//!   `revision` differs from the stored one. The rule exists because of
//!   server-side pruning (§7.7): updates at or below the snapshot watermark
//!   are answered with silence, so a `since` under the watermark **must** take
//!   the snapshot first. When an old server advertises no `snapshotMeta` at
//!   all and the cursor is not `0`, the reference does not fetch, and neither
//!   does this.
//! - **A replay is skipped, not re-applied** (§7.9): an update whose
//!   `sequenceNum <= cursor` is already in.
//! - **Stop at the gap** (§7.9). On an update this client cannot open, the
//!   document's pull **stops at that update** and the watermark is not
//!   advanced past it, so a later pass retries. Desktop advances past the gap
//!   and owes the document a re-pull; the chapter is explicit that a
//!   conforming client takes the stop-at-gap side, because it is the only one
//!   under which no update can be skipped permanently.
//! - **Durable before the cursor advances.** The update row and the cursor
//!   move in **one** transaction, per update rather than per page (§7.9), so a
//!   process killed mid-document resumes at the last update it actually
//!   stored and neither re-pulls nor skips.
//!
//! **`revision` is an opaque token compared only for equality** (§7.5). It is
//! never parsed, ordered or generated here.
//!
//! Two shapes are read tolerantly because chapter 07 does not write them down:
//! the **request** body of `POST /sync/crdt/updates/batch` appears nowhere in
//! the chapter, and the **response** of the single-document
//! `GET /sync/crdt/updates` is given only by analogy with §7.11's batch form.
//! This module therefore drives the single-document route, whose request
//! §7.2 does spell out (`note_id`, `since`, `limit`), and reads its answer
//! through both shapes. §7.3.1 says in as many words that both routes are
//! conforming.

use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde_json::Value as Json;

use crate::api::errors::{ApiError, StorageError};
use crate::crdt::update_log::{self, Namespace};
use crate::protocol::envelope::EnvelopeError;
use crate::protocol::http::{
    ApiRequest, Auth, HttpClient, RetryPolicy, SYNC_TYPES_HEADER, VAULT_ID_HEADER,
};
use crate::protocol::types::Declaration;
use crate::storage::Db;

use super::crdt_wire::{SnapshotMeta, UpdatePage, read_update_page};
use super::store;

/// §7.3: the client's own page size for a sweep, matching the reference's
/// `CRDT_UPDATES_PAGE_LIMIT`.
pub const CRDT_UPDATES_PAGE_LIMIT: u32 = 100;

/// How many pages one document's pull walks before yielding, so a single
/// document with a huge backlog cannot hold a first sync open indefinitely.
/// The next pass resumes from the committed cursor.
pub const MAX_PAGES_PER_DOCUMENT: u32 = 50;

/// The cursor scope for one document's body feed (chapter 05 §5.11: the
/// `scope` column exists for exactly this, and it is **not** a per-type record
/// cursor).
pub fn crdt_cursor_scope(doc_id: &str) -> String {
    format!("crdt:{doc_id}")
}

/// One packed envelope to open, chapter 04 §4.11.
pub struct PackedUpdate<'a> {
    /// Authenticated, not merely associated (§4.12): it is the first run of
    /// the signed message, so the wrong id fails as a signature error.
    pub doc_id: &'a str,
    /// Whose key to resolve. `None` when the server advertised none.
    pub signer_device_id: Option<&'a str>,
    pub packed: &'a [u8],
}

/// Opens one packed CRDT update.
///
/// A seam rather than a direct call to
/// [`crate::protocol::crdt_envelope::unpack`], for the same reason
/// [`super::pull::RecordCipher`] is one: opening needs the vault key **and**
/// the signer's Ed25519 public key resolved by `signerDeviceId`, and the key
/// directory is not this task's.
pub trait CrdtCipher: Send + Sync {
    fn open(&self, update: &PackedUpdate<'_>) -> Result<Vec<u8>, EnvelopeError>;
}

#[derive(Debug, thiserror::Error)]
pub enum BodyPullError {
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

/// What one body pull did. A per-document stop is **not** an error: it is an
/// entry in `stopped`, and the next pass retries it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BodyPullReport {
    pub documents: usize,
    /// Documents that took a snapshot baseline (§7.8).
    pub baselines: usize,
    /// Updates stored, each already durable with its cursor.
    pub updates: usize,
    /// Updates at or below the cursor, skipped as replays (§7.9).
    pub replays: usize,
    /// Documents whose pull stopped at an update this client could not open
    /// (§7.9). The cursor did **not** advance past it.
    pub stopped: Vec<String>,
    /// Documents whose durable log gained at least one update on this pull, so
    /// a **resident** `Document` for one of these is now behind its own log.
    ///
    /// The storage tier cannot fix that itself: it holds no
    /// [`crate::crdt::registry::DocumentRegistry`], and an update lands in
    /// `yjs_updates` rather than in whatever `Doc` a shell is currently
    /// showing. Without this list the divergence is invisible — the next
    /// `load_plan` replay quietly repairs it, so a shell that never reloads
    /// shows a note that stopped receiving remote edits and reports nothing.
    ///
    /// The same shape as [`crate::sync::pull::PullReport::purged_documents`]:
    /// name the ids, let the caller that owns the registry act.
    pub advanced_documents: Vec<String>,
}

impl BodyPullReport {
    pub fn absorb(&mut self, other: BodyPullReport) {
        self.documents += other.documents;
        self.baselines += other.baselines;
        self.updates += other.updates;
        self.replays += other.replays;
        self.stopped.extend(other.stopped);
        self.advanced_documents.extend(other.advanced_documents);
    }
}

/// The body pull. One per vault.
pub struct BodyPull {
    http: Arc<HttpClient>,
    db: Db,
    declaration: Declaration,
    cipher: Arc<dyn CrdtCipher>,
    vault_id: Option<String>,
}

impl BodyPull {
    pub fn new(
        http: Arc<HttpClient>,
        db: Db,
        declaration: Declaration,
        cipher: Arc<dyn CrdtCipher>,
    ) -> Self {
        Self {
            http,
            db,
            declaration,
            cipher,
            vault_id: None,
        }
    }

    pub fn with_vault(mut self, vault_id: &str) -> Self {
        self.vault_id = Some(vault_id.to_owned());
        self
    }

    /// Pulls every document in `doc_ids`, in order.
    ///
    /// **Callers must not pass a tombstoned id** (§7.15): the server still
    /// answers with the surviving log, and re-applying it resurrects body
    /// state for a document the record feed says is deleted.
    pub async fn pull_documents(
        &self,
        doc_ids: &[String],
    ) -> Result<BodyPullReport, BodyPullError> {
        let mut total = BodyPullReport::default();
        for doc_id in doc_ids {
            total.absorb(self.pull_document(doc_id).await?);
        }
        Ok(total)
    }

    /// One document: baseline if §7.8 says so, then incrementals.
    pub async fn pull_document(&self, doc_id: &str) -> Result<BodyPullReport, BodyPullError> {
        let mut report = BodyPullReport {
            documents: 1,
            ..BodyPullReport::default()
        };
        let mut cursor = self.read_cursor(doc_id).await?;

        // §7.8, first clause: a cursor of 0 always takes the snapshot first.
        // There is no incremental that could have told us about it, because
        // everything at or below the watermark is answered with silence.
        if cursor == 0 && self.fetch_baseline(doc_id, cursor, &mut report).await? {
            cursor = self.read_cursor(doc_id).await?;
        }

        for _ in 0..MAX_PAGES_PER_DOCUMENT {
            let page = self.fetch_page(doc_id, cursor).await?;

            // §7.8, second clause: the server advertises a snapshot ahead of
            // the cursor whose revision differs from the stored one.
            if let Some(meta) = page.snapshot_meta.as_ref()
                && self.baseline_due(doc_id, cursor, meta).await?
                && self.fetch_baseline(doc_id, cursor, &mut report).await?
            {
                cursor = self.read_cursor(doc_id).await?;
            }

            let mut stopped = false;
            for entry in page.updates {
                // §7.9: a replay, already applied.
                if entry.sequence_num <= cursor {
                    report.replays += 1;
                    continue;
                }
                let opened = BASE64.decode(&entry.data).ok().and_then(|packed| {
                    self.cipher
                        .open(&PackedUpdate {
                            doc_id,
                            signer_device_id: entry.signer_device_id.as_deref(),
                            packed: &packed,
                        })
                        .ok()
                });
                let Some(update) = opened else {
                    // §7.9's stop-at-gap. The watermark stays where it is and
                    // a later pass retries from here; advancing past the gap
                    // is the one behaviour under which an update can be lost
                    // permanently.
                    report.stopped.push(doc_id.to_owned());
                    stopped = true;
                    break;
                };
                self.store_update(doc_id, entry.sequence_num, update, entry.created_at)
                    .await?;
                cursor = entry.sequence_num;
                report.updates += 1;
                if report.advanced_documents.last().map(String::as_str) != Some(doc_id) {
                    report.advanced_documents.push(doc_id.to_owned());
                }
            }

            if stopped || !page.has_more {
                break;
            }
        }

        Ok(report)
    }

    /// `GET /sync/crdt/snapshot/:noteId` and the store that follows it (§7.8,
    /// §7.11). Answers whether a baseline was actually taken.
    async fn fetch_baseline(
        &self,
        doc_id: &str,
        cursor: i64,
        report: &mut BodyPullReport,
    ) -> Result<bool, BodyPullError> {
        let body: Json = self
            .http
            .send_json(
                self.request("GET", &format!("/sync/crdt/snapshot/{doc_id}"))
                    .retry(RetryPolicy::polled()),
            )
            .await?;

        // §7.11: `snapshot` is null when there is none. That is not a failure
        // and it is the ordinary answer for a document nobody has snapshotted.
        let Some(encoded) = body.get("snapshot").and_then(Json::as_str) else {
            return Ok(false);
        };
        let Ok(packed) = BASE64.decode(encoded) else {
            return Ok(false);
        };
        let sequence_num = body
            .get("sequenceNum")
            .and_then(Json::as_i64)
            .unwrap_or_default();
        let signer = body
            .get("signerDeviceId")
            .and_then(Json::as_str)
            .map(str::to_owned);
        // §7.11.1: the client MUST resolve the snapshot response's signer and
        // fail the baseline when it cannot.
        let Ok(snapshot) = self.cipher.open(&PackedUpdate {
            doc_id,
            signer_device_id: signer.as_deref(),
            packed: &packed,
        }) else {
            report.stopped.push(doc_id.to_owned());
            return Ok(false);
        };
        let revision = body
            .get("revision")
            .and_then(Json::as_str)
            .map(str::to_owned);

        self.store_baseline(doc_id, snapshot, sequence_num, revision, cursor)
            .await?;
        report.baselines += 1;
        Ok(true)
    }

    /// §7.8's second clause, against the locally stored revision.
    async fn baseline_due(
        &self,
        doc_id: &str,
        cursor: i64,
        meta: &SnapshotMeta,
    ) -> Result<bool, BodyPullError> {
        if meta.sequence_num <= cursor {
            return Ok(false);
        }
        let doc = doc_id.to_owned();
        let stored = self
            .db
            .call(move |conn| {
                update_log::snapshot(conn, Namespace::Server, &doc)
                    .map_err(|error| StorageError::Failed {
                        what: error.to_string(),
                    })
                    .map(|row| row.and_then(|row| row.server_revision))
            })
            .await?;
        // §7.5: compared for equality and for nothing else. A local NULL —
        // which is what a snapshot this device pushed stores, §7.13.4 — never
        // equals a server token, so it always yields to a baseline rather
        // than suppressing one.
        Ok(stored.as_deref() != Some(meta.revision.as_str()))
    }

    async fn fetch_page(&self, doc_id: &str, since: i64) -> Result<UpdatePage, BodyPullError> {
        let path = format!(
            "/sync/crdt/updates?note_id={doc_id}&since={since}&limit={CRDT_UPDATES_PAGE_LIMIT}"
        );
        let body: Json = self
            .http
            // §7.10: `maxRetries: 3`, `baseDelayMs: 2000`, `retryOn429:
            // false` on every CRDT request.
            .send_json(self.request("GET", &path).retry(RetryPolicy::polled()))
            .await?;
        Ok(read_update_page(&body, doc_id))
    }

    /// One update, durable **with** its cursor. §7.9 advances the watermark
    /// per update rather than per page, and the transaction is what makes a
    /// kill between the two impossible.
    async fn store_update(
        &self,
        doc_id: &str,
        sequence_num: i64,
        update: Vec<u8>,
        created_at: i64,
    ) -> Result<(), BodyPullError> {
        let doc = doc_id.to_owned();
        let scope = crdt_cursor_scope(doc_id);
        self.db
            .call(move |conn| {
                let txn = conn.unchecked_transaction().map_err(sqlite_failed)?;
                update_log::append_server_update(&txn, &doc, sequence_num, &update, created_at)
                    .map_err(crdt_failed)?;
                store::write_cursor(&txn, &scope, Some(&sequence_num.to_string()), created_at)?;
                txn.commit().map_err(sqlite_failed)?;
                Ok(())
            })
            .await?;
        Ok(())
    }

    /// §7.8: store the snapshot with its sequence number and revision, and
    /// advance the cursor **only if** the snapshot's sequence number is ahead.
    async fn store_baseline(
        &self,
        doc_id: &str,
        snapshot: Vec<u8>,
        sequence_num: i64,
        revision: Option<String>,
        cursor: i64,
    ) -> Result<(), BodyPullError> {
        let doc = doc_id.to_owned();
        let scope = crdt_cursor_scope(doc_id);
        let now = now_ms();
        self.db
            .call(move |conn| {
                let txn = conn.unchecked_transaction().map_err(sqlite_failed)?;
                update_log::put_server_snapshot(
                    &txn,
                    &doc,
                    &snapshot,
                    sequence_num,
                    revision.as_deref(),
                    now,
                )
                .map_err(crdt_failed)?;
                if sequence_num > cursor {
                    store::write_cursor(&txn, &scope, Some(&sequence_num.to_string()), now)?;
                }
                txn.commit().map_err(sqlite_failed)?;
                Ok(())
            })
            .await?;
        Ok(())
    }

    async fn read_cursor(&self, doc_id: &str) -> Result<i64, BodyPullError> {
        let scope = crdt_cursor_scope(doc_id);
        let stored = self
            .db
            .call(move |conn| store::read_cursor(conn, &scope))
            .await?;
        Ok(stored.and_then(|text| text.parse().ok()).unwrap_or(0))
    }

    fn request(&self, method: &str, path: &str) -> ApiRequest {
        let mut request = ApiRequest::new(method, path)
            .auth(Auth::Session)
            // §7.2: the CRDT routes sit behind the same sync-types middleware.
            .header(SYNC_TYPES_HEADER, &self.declaration.header_value());
        if let Some(vault_id) = &self.vault_id {
            request = request.header(VAULT_ID_HEADER, vault_id);
        }
        request
    }
}

fn crdt_failed(error: crate::crdt::CrdtError) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

fn sqlite_failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
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

    #[test]
    fn the_cursor_scope_is_the_document_feed_not_a_record_type() {
        assert_eq!(crdt_cursor_scope("abc123def456"), "crdt:abc123def456");
        assert_eq!(crdt_cursor_scope("j2026-04-16"), "crdt:j2026-04-16");
    }
}
