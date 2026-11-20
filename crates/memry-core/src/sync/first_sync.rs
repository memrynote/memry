//! The first-sync sub-sequence, data-model §C.3 and FR-028.
//!
//! > refs to the end, then metadata newest first, then bodies for the recent
//! > window, with determinate progress. App open is never blocked on any of
//! > it.
//!
//! **Whole vault, not a window (#5233).** With packs, the body pack phase
//! settles or owes every live document, so a vault the packs fully cover
//! takes every body from packs and owes nothing. The recent window below is
//! the path for partial coverage only: the first sync pulls the owed documents
//! inside it, and the shell then drains the rest in the foreground
//! ([`crate::sync::body_drain`]) until none is owed. FR-028's "older content
//! on demand" still holds for a note opened before the drain reaches it.
//!
//! **It is a sub-sequence, not a state.** Nothing here appears in §C.3's
//! diagram; the engine's states are unchanged and a first sync is three
//! ordered passes over the ordinary routes.
//!
//! ## Why windowing, and not a bootstrap session
//!
//! Chapter 10 §10.6.1 is explicit: SC-007 is met by **windowing** and by
//! raising `/sync/changes` to `limit=500`, **not** by the elevated session. A
//! session is one cheap call with a silent fallback and this module opens one
//! when it is handed a client, but a `501` — §10.12's unconfigured deployment
//! — changes nothing except how long the run takes.
//!
//! The steady-state arithmetic for a 10 000-item vault, which is the budget
//! this file is sized against:
//!
//! | Pass     | Calls                              | Unelevated ceiling | Time   |
//! | -------- | ---------------------------------- | ------------------ | ------ |
//! | refs     | 20 at `limit=500`                  | 60/min             | ~20 s  |
//! | metadata | 100 at 100 ids each                | 120/min            | ~50 s  |
//! | bodies   | [`RECENT_BODY_LIMIT`] documents    | 600/min            | ~50 s  |
//!
//! ## Why a kill resumes
//!
//! **Every pass's progress is durable in the data itself**, so there is no
//! separate checkpoint to fall out of step with:
//!
//! - the refs pass advances the one record cursor **after** the page's ref
//!   rows are recorded, in the same transaction (chapter 05 §5.11);
//! - the metadata pass's work list is literally
//!   `payload_state = 'metadata-only'` — the partial index data-model §A.2
//!   calls "the query the windowed first sync drives" — so an applied row
//!   removes itself from the list;
//! - the bodies pass advances a per-document `crdt:<docId>` cursor with each
//!   update it stores (chapter 07 §7.9).
//!
//! A process killed anywhere in the run therefore resumes at the last thing
//! it actually wrote. It re-pulls nothing that landed and skips nothing that
//! did not. The only durable bookkeeping is `first_sync.window_start`, which
//! exists so a **resumed** run uses the window the original run chose rather
//! than a window that slid forward while the app was dead, and
//! `first_sync.completed`.

use std::sync::Arc;

use serde_json::Value as Json;

use crate::api::errors::StorageError;
use crate::storage::{Db, nested_tx};

use super::body_pull::{BodyPull, BodyPullError, BodyPullReport};
use super::bootstrap::BootstrapClient;
use super::first_sync_store::{pending_metadata_ids, read_meta, record_ref, write_meta};
use super::note_body_feed;
use super::pack_bootstrap::{BodyPackReport, PackBootstrap, RecordPackReport};

mod body_pass;
mod progress;
mod reconcile;
mod refs;

pub(crate) use progress::read_body_counts;

use refs::{read_refs_page, reference_now};

use super::pull::{PULL_PAGE_LIMIT, PullError, PullLoop};
use super::store::{self, RECORD_CURSOR_SCOPE};
pub use body_pass::{
    BODY_CONCURRENCY_ELEVATED, BODY_CONCURRENCY_STEADY, MAX_RATE_LIMIT_PAUSE_S,
    MAX_RATE_LIMIT_PAUSES,
};

/// `meta` keys, data-model §A.2's reserved list.
pub const META_FIRST_SYNC_COMPLETED: &str = "first_sync.completed";
pub const META_FIRST_SYNC_WINDOW_START: &str = "first_sync.window_start";
/// Set once the record pack phase ended: `1` when record packs were applied,
/// so the manifest reconcile is due, `0` when none were.
pub const META_FIRST_SYNC_RECORD_PACKS: &str = "first_sync.record_packs";
/// Set once the body pack phase ended: `1` when it settled or owed every
/// live document, `0` when the bodies were left to the item-granular pass.
pub const META_FIRST_SYNC_BODY_PACKS: &str = "first_sync.body_packs";
pub use reconcile::META_FIRST_SYNC_RECONCILED;

/// How far back "recent" reaches, in milliseconds. Thirty days.
///
/// **No chapter states this number.** §10.6.1 mandates windowing and leaves
/// the window to the client, so this is the core's answer and it is stated
/// here rather than buried: thirty days is the span in which a returning
/// user's own writing lives, and it is persisted at
/// [`META_FIRST_SYNC_WINDOW_START`] so a resumed run does not quietly choose
/// a different one.
pub const RECENT_WINDOW_MS: i64 = 30 * 24 * 60 * 60 * 1_000;

/// The ceiling on bodies the first sync pulls item by item before declaring
/// itself done, when packs did not cover the vault.
///
/// The window alone is not a bound: a vault whose whole history landed last
/// week has every document inside thirty days, and pulling ten thousand
/// bodies is seventeen minutes unelevated (§10.6.1) against SC-007's two.
/// Everything past this stays owed, and the shell's foreground drain pulls it
/// next (#5233); a note opened first loads on demand (FR-028).
pub const RECENT_BODY_LIMIT: usize = 500;

/// How many ids one metadata call asks for. Chapter 05 §5.10: `POST
/// /sync/pull` takes at most 100.
pub const METADATA_CHUNK: usize = 100;

/// Which part of the vault is arriving.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FirstSyncPhase {
    /// Note records: record packs, the feed, the reconcile, the metadata pass.
    Records,
    /// Note bodies: body packs, then the owed documents.
    Bodies,
    Done,
}

/// FR-028's determinate progress, in live notes and journals (#5233).
///
/// `total` is never below `completed`, so a shell can render a fraction
/// without guarding against one above 1. It is `None` while the vault's total
/// is not yet known (records before the feed's end). Every count is read from
/// this device's tables, which a bootstrap session does not affect, so the
/// numbers survive Q10.2's mid-run fallback unchanged.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FirstSyncProgress {
    pub phase: FirstSyncPhase,
    pub completed: u64,
    pub total: Option<u64>,
}

/// Where progress goes. Synchronous, because a shell's progress bar is not
/// worth an await and a sink that blocked would stall the pass reporting it.
pub trait ProgressSink: Send + Sync {
    fn progress(&self, progress: FirstSyncProgress);
}

/// A sink that drops everything, for a caller that does not want progress.
pub struct SilentProgress;

impl ProgressSink for SilentProgress {
    fn progress(&self, _progress: FirstSyncProgress) {}
}

/// What the run did, per pass.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FirstSyncReport {
    pub refs_pages: u32,
    pub refs_recorded: usize,
    pub tombstones: usize,
    pub metadata_applied: usize,
    pub metadata_corrupt: usize,
    /// Records taken from `record` packs (chapter 08 §8.4.2).
    pub record_packs: RecordPackReport,
    /// Items the manifest reconcile pulled by id (§8.10).
    pub reconcile_pulled: usize,
    /// Pack-held rows the reconcile found deleted on the server and removed.
    pub reconcile_removed: usize,
    /// Requests the reconcile sent: the manifest plus its pulls.
    pub reconcile_requests: usize,
    /// Bodies from `crdt_snapshot` and `crdt_update` packs (§8.4.3, §8.10).
    pub body_packs: BodyPackReport,
    pub bodies: BodyPullReport,
    /// Live documents still owed a body when the run ended.
    pub bodies_owed: usize,
    /// The window boundary this run used, epoch milliseconds.
    pub window_start: i64,
    /// Whether the session was elevated (§10.7). Informational: the run is
    /// byte-for-byte identical either way.
    pub elevated: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum FirstSyncError {
    #[error("{source}")]
    Pull {
        #[from]
        source: PullError,
    },
    #[error("{source}")]
    Body {
        #[from]
        source: BodyPullError,
    },
    #[error("{source}")]
    Storage {
        #[from]
        source: StorageError,
    },
}

/// The first sync. Built once per vault and run on a background task.
///
/// **Nothing here runs at construction**, which is half of FR-028's "app open
/// never blocked on the network": building this makes no request and takes no
/// lock, and [`FirstSync::is_complete`] is a single local read. The other
/// half is that every surface reads `sync_items` and the projections, which
/// are populated incrementally as the passes land, so content is browsable
/// while the run is still going.
pub struct FirstSync {
    pull: Arc<PullLoop>,
    bodies: Arc<BodyPull>,
    db: Db,
    bootstrap: Option<Arc<BootstrapClient>>,
    packs: Option<Arc<PackBootstrap>>,
    progress: Arc<dyn ProgressSink>,
}

impl FirstSync {
    pub fn new(pull: Arc<PullLoop>, bodies: Arc<BodyPull>, db: Db) -> Self {
        Self {
            pull,
            bodies,
            db,
            bootstrap: None,
            packs: None,
            progress: Arc::new(SilentProgress),
        }
    }

    /// §10.6: a client SHOULD open a session, and every failure is silent.
    pub fn with_bootstrap(mut self, bootstrap: Arc<BootstrapClient>) -> Self {
        self.bootstrap = Some(bootstrap);
        self
    }

    /// Takes records and bodies from packs (chapter 08). Every pack failure
    /// falls back to the item-granular passes.
    pub fn with_packs(mut self, packs: Arc<PackBootstrap>) -> Self {
        self.packs = Some(packs);
        self
    }

    pub fn with_progress(mut self, progress: Arc<dyn ProgressSink>) -> Self {
        self.progress = progress;
        self
    }

    /// Whether this device has already finished a first sync for this vault.
    pub async fn is_complete(&self) -> Result<bool, FirstSyncError> {
        Ok(self
            .db
            .call(|conn| read_meta(conn, META_FIRST_SYNC_COMPLETED))
            .await?
            .is_some())
    }

    /// The whole sub-sequence: refs, metadata, bodies, in that order.
    ///
    /// Ordered, not interleaved, because each pass is the next one's work
    /// list: metadata is the rows refs recorded, bodies are the documents
    /// metadata typed and dated.
    pub async fn run(&self, now_ms: i64) -> Result<FirstSyncReport, FirstSyncError> {
        let mut report = FirstSyncReport::default();

        // §10.5: this cannot fail in any way a caller must handle.
        if let Some(bootstrap) = &self.bootstrap {
            report.elevated = bootstrap.open(now_ms / 1_000).await.elevated();
        }

        // Close on every exit after the open, so a failed run frees its slot;
        // the guard closes a run dropped mid-flight. A close failure is logged
        // by the client and never fails the run.
        let _close = self.bootstrap.as_ref().map(BootstrapClient::close_on_drop);
        let passes = self.passes(now_ms, &mut report).await;
        if let Some(bootstrap) = &self.bootstrap {
            bootstrap.close().await;
        }
        passes?;
        self.progress.progress(FirstSyncProgress {
            phase: FirstSyncPhase::Done,
            completed: 1,
            total: Some(1),
        });
        Ok(report)
    }

    async fn passes(
        &self,
        now_ms: i64,
        report: &mut FirstSyncReport,
    ) -> Result<(), FirstSyncError> {
        report.window_start = self.window_start(now_ms).await?;

        // Records first (#5232): packs, then the feed from where they end,
        // then the manifest decides, so the note list fills before any body.
        let record_packs_used = self.record_packs_pass(report).await?;
        self.refs_pass(report).await?;
        // The feed has been read to its end: the vault's total is known.
        self.records_progress(true).await?;
        if record_packs_used {
            self.reconcile(report).await?;
        }
        self.metadata_pass(report).await?;
        // After the reconcile, so a document whose record is a tombstone or
        // absent takes no packed body (§8.10).
        let body_packs_used = self.body_packs_pass(report).await?;
        self.bodies_pass(report.window_start, body_packs_used, report)
            .await?;
        report.bodies_owed = read_body_counts(&self.db).await?.1 as usize;

        self.db
            .call(move |conn| write_meta(conn, META_FIRST_SYNC_COMPLETED, &now_ms.to_string()))
            .await?;
        Ok(())
    }

    /// Records from `record` packs, once, on a device that holds no record
    /// cursor yet. Answers whether any record pack is held, which makes the
    /// manifest reconcile due.
    ///
    /// The record cursor moves to the packs' tail start (§8.10) in the
    /// transaction that ends the phase, so a run killed before it repeats the
    /// phase (finished packs are not downloaded again) and one killed after it
    /// tails the feed from there.
    async fn record_packs_pass(
        &self,
        report: &mut FirstSyncReport,
    ) -> Result<bool, FirstSyncError> {
        if let Some(text) = self
            .db
            .call(|conn| read_meta(conn, META_FIRST_SYNC_RECORD_PACKS))
            .await?
        {
            return Ok(text == "1");
        }
        let fresh = self
            .db
            .call(|conn| store::read_cursor(conn, RECORD_CURSOR_SCOPE))
            .await?
            .is_none();
        let (used, tail_start) = match &self.packs {
            Some(packs) if fresh => {
                // A fresh device holds no record yet, so the documents the
                // packs applied are the documents it holds.
                let progress = Arc::clone(&self.progress);
                let on_progress = move |documents: u64| {
                    progress.progress(FirstSyncProgress {
                        phase: FirstSyncPhase::Records,
                        completed: documents,
                        total: None,
                    });
                };
                let records = packs
                    .run_records(&self.pull, now_ms() / 1_000, &on_progress)
                    .await?;
                let ended = (records.used, records.tail_start);
                report.record_packs = records;
                ended
            }
            _ => (false, 0),
        };
        self.db
            .call(move |conn| {
                let txn = nested_tx::begin(conn).map_err(sqlite_failed)?;
                if tail_start > 0 {
                    let cursor = tail_start.to_string();
                    store::write_cursor(&txn, RECORD_CURSOR_SCOPE, Some(&cursor), now_ms())?;
                }
                write_meta(
                    &txn,
                    META_FIRST_SYNC_RECORD_PACKS,
                    if used { "1" } else { "0" },
                )?;
                txn.commit().map_err(sqlite_failed)
            })
            .await?;
        Ok(used)
    }

    /// Pass one: `GET /sync/changes` to the end.
    ///
    /// Refs only. The page's ciphertext is **not** fetched here — that is
    /// pass two's job, and separating them is the whole point of the
    /// windowing: on a large vault the refs pass is twenty calls and gives
    /// the client the complete inventory it needs to order everything else.
    async fn refs_pass(&self, report: &mut FirstSyncReport) -> Result<(), FirstSyncError> {
        loop {
            let cursor = self
                .db
                .call(|conn| store::read_cursor(conn, RECORD_CURSOR_SCOPE))
                .await?;
            let mut path = format!("/sync/changes?limit={PULL_PAGE_LIMIT}");
            if let Some(cursor) = &cursor {
                path.push_str("&cursor=");
                path.push_str(cursor);
            }
            let request = self.elevate(self.pull.request("GET", &path)).await;
            let body: Json = self
                .http_send(request)
                .await
                .map_err(|source| FirstSyncError::Pull { source })?;

            let page = read_refs_page(&body);
            let next = page.next_cursor.clone().or(cursor);
            let recorded = page.refs.len();
            let tombstones = page.deleted.len();

            // Durable **before** the cursor advances, in one transaction, so
            // a kill here resumes at this page rather than past it.
            let stored = next.clone();
            let refs = page.refs;
            let deleted = page.deleted;
            self.db
                .call(move |conn| {
                    let txn = nested_tx::begin(conn).map_err(sqlite_failed)?;
                    for reference in &refs {
                        record_ref(
                            &txn,
                            &reference.item_type,
                            &reference.item_id,
                            reference.modified_at,
                        )?;
                    }
                    // §5.12.1: an id in `deleted` may have no type on the
                    // wire, and the refs-only pass has no envelope to read one
                    // from. Marking every row for that id, and filing a bare
                    // tombstone when there is none, is idempotent and is what
                    // stops pass two resurrecting it.
                    for item_id in &deleted {
                        store::apply_untyped_tombstone(
                            &txn,
                            item_id,
                            reference_now(&refs, item_id),
                            reference_now(&refs, item_id),
                        )?;
                    }
                    // The refs pass serves no bodies (#2299).
                    note_body_feed::rearm_legacy_pull(&txn)?;
                    store::write_cursor(&txn, RECORD_CURSOR_SCOPE, stored.as_deref(), now_ms())?;
                    txn.commit().map_err(sqlite_failed)?;
                    Ok(())
                })
                .await?;

            report.refs_pages += 1;
            report.refs_recorded += recorded;
            report.tombstones += tombstones;

            if !page.has_more {
                return Ok(());
            }
            self.records_progress(false).await?;
        }
    }

    /// Pass two: `POST /sync/pull` over the metadata-only rows, newest first.
    ///
    /// Newest first is the whole of "recently modified content is available
    /// first" (FR-028): the rows are ordered by the `modifiedAt` the refs pass
    /// wrote, so the notes a user is most likely to reach for are typed and
    /// dated before the rest of the vault is touched.
    async fn metadata_pass(&self, report: &mut FirstSyncReport) -> Result<(), FirstSyncError> {
        let outstanding = self.db.call(|conn| pending_metadata_ids(conn)).await?;
        for chunk in outstanding.chunks(METADATA_CHUNK) {
            let page = self.pull.fetch_ids(chunk).await?;
            report.metadata_applied += page.applied;
            report.metadata_corrupt += page.corrupt;
            self.records_progress(true).await?;
        }
        Ok(())
    }

    /// The window boundary, chosen once and remembered.
    async fn window_start(&self, now_ms: i64) -> Result<i64, FirstSyncError> {
        if let Some(stored) = self
            .db
            .call(|conn| read_meta(conn, META_FIRST_SYNC_WINDOW_START))
            .await?
            .and_then(|text| text.parse::<i64>().ok())
        {
            return Ok(stored);
        }
        let chosen = now_ms - RECENT_WINDOW_MS;
        self.db
            .call(move |conn| write_meta(conn, META_FIRST_SYNC_WINDOW_START, &chosen.to_string()))
            .await?;
        Ok(chosen)
    }

    /// §10.11 rule 1 and 2, applied at the one place a request is built: renew
    /// at the lead, and on any failure drop the header and keep going.
    async fn elevate(
        &self,
        request: crate::protocol::http::ApiRequest,
    ) -> crate::protocol::http::ApiRequest {
        let Some(bootstrap) = &self.bootstrap else {
            return request;
        };
        let now_s = now_ms() / 1_000;
        bootstrap.renew_if_due(now_s).await;
        bootstrap.elevate(request, now_s)
    }

    async fn http_send(
        &self,
        request: crate::protocol::http::ApiRequest,
    ) -> Result<Json, PullError> {
        Ok(self.pull.http().send_json(request).await?)
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
    fn the_window_is_thirty_days_and_the_body_cap_fits_sc_007() {
        assert_eq!(RECENT_WINDOW_MS, 2_592_000_000);
        // §10.6.1: 600 `crdt_pull` per minute unelevated, so the cap has to
        // stay under a minute of body pulling on its own or SC-007's two
        // minutes are gone before the refs and metadata passes are counted.
        assert_eq!(RECENT_BODY_LIMIT.min(600), RECENT_BODY_LIMIT);
    }
}
