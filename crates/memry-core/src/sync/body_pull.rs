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
//!   `0`, or when the server advertises a snapshot whose `revision` differs
//!   from the stored one (#2299: not only one ahead of the cursor, because a
//!   `coversThrough` push moves the watermark over rows it prunes). The rule
//!   exists because of server-side pruning (§7.7): updates at or below the snapshot watermark
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
//! - **Durable before the cursor advances.** A page's update rows and the
//!   cursor of its last one move in **one** transaction (§7.9, #5231), so a
//!   process killed mid-page resumes at the last page it actually stored and
//!   pulls that page again; `INSERT OR IGNORE` makes the replay a no-op and
//!   nothing is skipped.
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
//!
//! The single-document route carries no `snapshotMeta`, though, so a
//! document above cursor `0` could never meet §7.8's second clause: once a
//! peer's snapshot pruned the log past this device's cursor, the document
//! went silent for good. Every document is therefore probed first through the
//! batch route (desktop's `CRDT batch chunk probed`), one request per hundred
//! documents, for the meta and the first page (#5293). A probe that shows
//! nothing above the cursor and no baseline due settles the document with no
//! further request, as desktop's probe phase does, so a resumed first sync
//! does not pull its finished documents again. With no baseline due, the
//! probe's page is the document's first page.

use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde_json::Value as Json;

use crate::api::errors::{ApiError, StorageError};
use crate::protocol::envelope::EnvelopeError;
use crate::protocol::http::{
    ApiRequest, Auth, HttpClient, RetryPolicy, SYNC_TYPES_HEADER, VAULT_ID_HEADER,
};
use crate::protocol::types::Declaration;
use crate::storage::Db;

use super::bootstrap::BootstrapClient;
use super::crdt_wire::{SnapshotMeta, UpdateEntry, UpdatePage, read_update_page};
use super::crypto_batch::off_runtime;
use super::driver::observer::Observers;
use super::store;

mod baseline;
mod log_writes;
mod manifest;
mod pack_seed;
mod probe;
use probe::ProbeAnswer;

pub use manifest::CRDT_MANIFEST_PAGE_LIMIT;
pub use pack_seed::{PACK_SEED_CHUNK, PackEntrySeed, PackSeed, PackUpdateSeed};
pub(super) use probe::Probed;

/// §7.3: the client's own page size for a sweep, matching the reference's
/// `CRDT_UPDATES_PAGE_LIMIT`.
pub const CRDT_UPDATES_PAGE_LIMIT: u32 = 100;

/// How many pages one document's pull walks before yielding, so a single
/// document with a huge backlog cannot hold a first sync open indefinitely.
/// The next pass resumes from the committed cursor.
pub const MAX_PAGES_PER_DOCUMENT: u32 = 50;

/// Documents per snapshot-meta probe: the batch route's own cap (§7.3).
pub(super) const PROBE_CHUNK: usize = 100;

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

    /// Every device id whose key [`Self::open`] can resolve.
    ///
    /// A pack's index carries no signer (chapter 08 §8.3), so a packed
    /// snapshot is opened against each of these in turn, as desktop's
    /// `crdt-snapshot-applier` does. Empty means packed snapshots cannot be
    /// verified here and every note keeps its item-granular baseline GET.
    fn signer_candidates(&self) -> Vec<String> {
        Vec::new()
    }
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
    /// Documents whose pull yielded at [`MAX_PAGES_PER_DOCUMENT`] with the
    /// server still reporting `hasMore`. Nothing was skipped, but the log does
    /// not reach the server's head yet, so a body debt is not settled.
    pub incomplete: Vec<String>,
    /// Requests this pull sent, so a caller can hold a per-pass budget.
    pub requests: usize,
}

impl BodyPullReport {
    pub fn absorb(&mut self, other: BodyPullReport) {
        self.documents += other.documents;
        self.baselines += other.baselines;
        self.updates += other.updates;
        self.replays += other.replays;
        self.stopped.extend(other.stopped);
        self.advanced_documents.extend(other.advanced_documents);
        self.incomplete.extend(other.incomplete);
        self.requests += other.requests;
    }

    /// Whether every document this report covers reached the server's head
    /// and stored everything on the way: the only pull that settles a debt.
    pub fn merged(&self) -> bool {
        self.stopped.is_empty() && self.incomplete.is_empty()
    }
}

/// The body pull. One per vault.
pub struct BodyPull {
    http: Arc<HttpClient>,
    db: Db,
    declaration: Declaration,
    cipher: Arc<dyn CrdtCipher>,
    vault_id: Option<String>,
    bootstrap: Option<Arc<BootstrapClient>>,
    observers: Option<Arc<Observers>>,
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
            bootstrap: None,
            observers: None,
        }
    }

    /// Tells `observers` of each document whose stored body changed, once
    /// the write has committed: a pull that stored a baseline or an update,
    /// and a pack seed that applied.
    pub fn with_observers(mut self, observers: Arc<Observers>) -> Self {
        self.observers = Some(observers);
        self
    }

    async fn tell_observers(&self, doc_id: &str) {
        if let Some(observers) = &self.observers {
            observers.bodies_applied(vec![doc_id.to_owned()]).await;
        }
    }

    /// Chapter 10 §10.7: every route this pull sends is an elevated pull
    /// bucket (`crdt_pull`, `crdt_batch_pull`), so a first sync's session
    /// token rides on all of them. Without it the body pass runs at the
    /// steady-state 600/min however the run was opened.
    ///
    /// Header only: renewal is the owner's to schedule
    /// ([`BootstrapClient::renew_if_due`]), so concurrent document pulls never
    /// race each other into two renewals.
    pub fn with_bootstrap(mut self, bootstrap: Arc<BootstrapClient>) -> Self {
        self.bootstrap = Some(bootstrap);
        self
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
        for chunk in doc_ids.chunks(PROBE_CHUNK) {
            let mut probed = self.probe(chunk, &mut total.requests).await?;
            for doc_id in chunk {
                total.absorb(self.pull_with(doc_id, probed.remove(doc_id)).await?);
            }
        }
        Ok(total)
    }

    /// One document: baseline if §7.8 says so, then incrementals.
    pub async fn pull_document(&self, doc_id: &str) -> Result<BodyPullReport, BodyPullError> {
        let mut probes = 0;
        let mut probed = self.probe(&[doc_id.to_owned()], &mut probes).await?;
        let mut report = self.pull_with(doc_id, probed.remove(doc_id)).await?;
        report.requests += probes;
        Ok(report)
    }

    pub(super) async fn pull_with(
        &self,
        doc_id: &str,
        probed: Option<Probed>,
    ) -> Result<BodyPullReport, BodyPullError> {
        let mut report = BodyPullReport {
            documents: 1,
            ..BodyPullReport::default()
        };
        // Taken by value: the probe page moves into the first page below
        // and is dropped once applied, never copied.
        let Probed {
            meta,
            current,
            answer,
        } = probed.unwrap_or_default();
        if current {
            return Ok(report);
        }
        // Told on the error path too: a page that fails after earlier pages
        // committed leaves those updates stored.
        let pulled = self
            .pull_stored(doc_id, meta.as_ref(), answer, &mut report)
            .await;
        if report.baselines + report.updates > 0 {
            self.tell_observers(doc_id).await;
        }
        pulled.map(|()| report)
    }

    async fn pull_stored(
        &self,
        doc_id: &str,
        meta: Option<&SnapshotMeta>,
        answer: Option<ProbeAnswer>,
        report: &mut BodyPullReport,
    ) -> Result<(), BodyPullError> {
        let mut cursor = self.read_cursor(doc_id).await?;
        let mut first_page = None;

        if let Some(answer) = answer {
            // §7.8 from the batch answer: a baseline when the server's
            // snapshot is not the one held, whatever the cursor (a cursor of
            // 0 holds none, unless a snapshot at `sequenceNum` 0 was taken).
            // No server snapshot (§7.11) takes none.
            let due = match meta {
                Some(meta) => self.baseline_due(doc_id, meta).await?,
                None => false,
            };
            if due {
                if self.fetch_baseline(doc_id, cursor, report).await? {
                    cursor = self.read_cursor(doc_id).await?;
                } else if !report.stopped.is_empty() {
                    return Ok(());
                }
            } else if answer.since == cursor {
                // #5293: the answer is this document's first page already.
                first_page = Some(answer.page);
            }
        } else {
            // §7.8, first clause: a cursor of 0 always takes the snapshot
            // first. There is no incremental that could have told us about
            // it, because everything at or below the watermark is answered
            // with silence.
            if cursor == 0 {
                if self.fetch_baseline(doc_id, cursor, report).await? {
                    cursor = self.read_cursor(doc_id).await?;
                } else if !report.stopped.is_empty() {
                    // A baseline that exists and could not be used: paging on
                    // from 0 would store the updates above the watermark and
                    // move the cursor past the state below it for good.
                    return Ok(());
                }
            }
            // §7.8, second clause, from a probe whose meta is all it gave: a
            // server before #2299 sends no `snapshotMeta` on the
            // single-document route, so without it a snapshot that pruned the
            // log above this cursor would leave the document silent forever.
            if cursor > 0
                && let Some(meta) = meta
                && self.baseline_due(doc_id, meta).await?
            {
                if self.fetch_baseline(doc_id, cursor, report).await? {
                    cursor = self.read_cursor(doc_id).await?;
                } else if !report.stopped.is_empty() {
                    return Ok(());
                }
            }
        }

        let mut has_more = false;
        for _ in 0..MAX_PAGES_PER_DOCUMENT {
            let page = match first_page.take() {
                Some(page) => page,
                None => self.fetch_page(doc_id, cursor, report).await?,
            };

            // §7.8, second clause, widened by #2299: the server advertises a
            // snapshot whose revision differs from the stored one.
            if let Some(meta) = page.snapshot_meta.as_ref()
                && self.baseline_due(doc_id, meta).await?
            {
                if self.fetch_baseline(doc_id, cursor, report).await? {
                    cursor = self.read_cursor(doc_id).await?;
                } else if !report.stopped.is_empty() {
                    return Ok(());
                }
            }

            let mut stopped = false;
            let has_more_here = page.has_more;
            let mut opened_page = Vec::new();
            for (entry, opened) in self.open_page(doc_id, cursor, page.updates).await? {
                // §7.9: a replay, already applied.
                let last = opened_page.last().map_or(cursor, |(seq, _)| *seq);
                if entry.sequence_num <= last {
                    report.replays += 1;
                    continue;
                }
                let Some(update) = opened else {
                    // §7.9's stop-at-gap. The watermark stays where it is and
                    // a later pass retries from here; advancing past the gap
                    // is the one behaviour under which an update can be lost
                    // permanently.
                    report.stopped.push(doc_id.to_owned());
                    stopped = true;
                    break;
                };
                opened_page.push((entry.sequence_num, update));
            }
            // The updates before a gap are stored; the cursor stops there.
            if let Some(&(last, _)) = opened_page.last() {
                report.updates += opened_page.len();
                self.store_updates(doc_id, opened_page).await?;
                cursor = last;
                if report.advanced_documents.last().map(String::as_str) != Some(doc_id) {
                    report.advanced_documents.push(doc_id.to_owned());
                }
            }

            has_more = has_more_here;
            if stopped || !has_more_here {
                break;
            }
        }
        if has_more && report.stopped.is_empty() {
            report.incomplete.push(doc_id.to_owned());
        }
        // #4315: a pull that reached an empty head still read the server body.
        // Without a cursor the feed treats the document as never fetched and
        // drops every update typed into it afterwards.
        if cursor == 0 && report.merged() {
            self.hold_empty_body(doc_id).await?;
        }

        Ok(())
    }

    /// Opens every update of a page past `cursor` in one batch on
    /// `spawn_blocking` (#3534); a replay is not opened. `None` is an update
    /// that does not decode or open, where §7.9 stops the document.
    async fn open_page(
        &self,
        doc_id: &str,
        cursor: i64,
        updates: Vec<UpdateEntry>,
    ) -> Result<Vec<(UpdateEntry, Option<Vec<u8>>)>, BodyPullError> {
        let cipher = Arc::clone(&self.cipher);
        let doc_id = doc_id.to_owned();
        let open = move || {
            let open_one = |entry: &UpdateEntry| {
                let packed = BASE64.decode(&entry.data).ok()?;
                let update = PackedUpdate {
                    doc_id: &doc_id,
                    signer_device_id: entry.signer_device_id.as_deref(),
                    packed: &packed,
                };
                cipher.open(&update).ok()
            };
            updates
                .into_iter()
                .map(|entry| {
                    let opened = (entry.sequence_num > cursor)
                        .then(|| open_one(&entry))
                        .flatten();
                    (entry, opened)
                })
                .collect()
        };
        Ok(off_runtime("opening a body page", open).await?)
    }

    async fn fetch_page(
        &self,
        doc_id: &str,
        since: i64,
        report: &mut BodyPullReport,
    ) -> Result<UpdatePage, BodyPullError> {
        report.requests += 1;
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

    async fn read_cursor(&self, doc_id: &str) -> Result<i64, BodyPullError> {
        Ok(self.stored_cursor(doc_id).await?.unwrap_or(0))
    }

    /// `None` when this device never pulled the document.
    async fn stored_cursor(&self, doc_id: &str) -> Result<Option<i64>, BodyPullError> {
        let scope = crdt_cursor_scope(doc_id);
        let stored = self
            .db
            .call(move |conn| store::read_cursor(conn, &scope))
            .await?;
        Ok(stored.and_then(|text| text.parse().ok()))
    }

    fn request(&self, method: &str, path: &str) -> ApiRequest {
        let mut request = ApiRequest::new(method, path)
            .auth(Auth::Session)
            // §7.2: the CRDT routes sit behind the same sync-types middleware.
            .header(SYNC_TYPES_HEADER, &self.declaration.header_value());
        if let Some(vault_id) = &self.vault_id {
            request = request.header(VAULT_ID_HEADER, vault_id);
        }
        if let Some(bootstrap) = &self.bootstrap {
            request = bootstrap.elevate(request, now_ms() / 1_000);
        }
        request
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
