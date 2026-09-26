//! The first-sync sub-sequence, data-model §C.3 and FR-028.
//!
//! > refs to the end, then metadata newest first, then bodies for the recent
//! > window, with determinate progress. App open is never blocked on any of
//! > it.
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
use crate::storage::Db;
use crate::storage::repositories::sync_items;

use super::body_pull::{BodyPull, BodyPullError, BodyPullReport};
use super::bootstrap::BootstrapClient;
use super::first_sync_store::{pending_metadata_ids, read_meta, recent_document_ids, write_meta};
use super::note_body_feed;
use super::pull::{PULL_PAGE_LIMIT, PullError, PullLoop};
use super::store::{self, RECORD_CURSOR_SCOPE};

/// `meta` keys, data-model §A.2's reserved list.
pub const META_FIRST_SYNC_COMPLETED: &str = "first_sync.completed";
pub const META_FIRST_SYNC_WINDOW_START: &str = "first_sync.window_start";

/// How far back "recent" reaches, in milliseconds. Thirty days.
///
/// **No chapter states this number.** §10.6.1 mandates windowing and leaves
/// the window to the client, so this is the core's answer and it is stated
/// here rather than buried: thirty days is the span in which a returning
/// user's own writing lives, and it is persisted at
/// [`META_FIRST_SYNC_WINDOW_START`] so a resumed run does not quietly choose
/// a different one.
pub const RECENT_WINDOW_MS: i64 = 30 * 24 * 60 * 60 * 1_000;

/// The ceiling on bodies the first sync pulls before declaring itself done.
///
/// The window alone is not a bound: a vault whose whole history landed last
/// week has every document inside thirty days, and pulling ten thousand
/// bodies is seventeen minutes unelevated (§10.6.1) against SC-007's two.
/// Everything past this loads on demand, which is exactly what FR-028 asks
/// for — "older content on demand".
pub const RECENT_BODY_LIMIT: usize = 500;

/// How many ids one metadata call asks for. Chapter 05 §5.10: `POST
/// /sync/pull` takes at most 100.
pub const METADATA_CHUNK: usize = 100;

/// Which pass the run is in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FirstSyncPhase {
    /// `GET /sync/changes` to the end of the feed.
    Refs,
    /// `POST /sync/pull`, newest first.
    Metadata,
    /// `GET /sync/crdt/updates` for the recent window.
    Bodies,
    Done,
}

/// FR-028's determinate progress.
///
/// `total` is never below `completed`, so a shell can render a fraction
/// without guarding against one above 1. §10.11: progress is measured against
/// the tail cursor and the client's own cursor, neither of which a bootstrap
/// session affects — so the numbers survive Q10.2's mid-run fallback
/// unchanged, and the only observable difference is that the run takes
/// longer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FirstSyncProgress {
    pub phase: FirstSyncPhase,
    pub completed: u64,
    pub total: u64,
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
    pub bodies: BodyPullReport,
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
    progress: Arc<dyn ProgressSink>,
}

impl FirstSync {
    pub fn new(pull: Arc<PullLoop>, bodies: Arc<BodyPull>, db: Db) -> Self {
        Self {
            pull,
            bodies,
            db,
            bootstrap: None,
            progress: Arc::new(SilentProgress),
        }
    }

    /// §10.6: a client SHOULD open a session, and every failure is silent.
    pub fn with_bootstrap(mut self, bootstrap: Arc<BootstrapClient>) -> Self {
        self.bootstrap = Some(bootstrap);
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
        let tail_cursor = match &self.bootstrap {
            Some(bootstrap) => {
                let opened = bootstrap.open(now_ms / 1_000).await;
                report.elevated = opened.elevated();
                opened.tail_cursor
            }
            None => 0,
        };

        report.window_start = self.window_start(now_ms).await?;

        self.refs_pass(tail_cursor, &mut report).await?;
        self.metadata_pass(&mut report).await?;
        self.bodies_pass(report.window_start, &mut report).await?;

        self.db
            .call(move |conn| write_meta(conn, META_FIRST_SYNC_COMPLETED, &now_ms.to_string()))
            .await?;
        if let Some(bootstrap) = &self.bootstrap {
            bootstrap.close().await;
        }
        self.progress.progress(FirstSyncProgress {
            phase: FirstSyncPhase::Done,
            completed: 1,
            total: 1,
        });
        Ok(report)
    }

    /// Pass one: `GET /sync/changes` to the end.
    ///
    /// Refs only. The page's ciphertext is **not** fetched here — that is
    /// pass two's job, and separating them is the whole point of the
    /// windowing: on a large vault the refs pass is twenty calls and gives
    /// the client the complete inventory it needs to order everything else.
    async fn refs_pass(
        &self,
        tail_cursor: i64,
        report: &mut FirstSyncReport,
    ) -> Result<(), FirstSyncError> {
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
                    let txn = conn.unchecked_transaction().map_err(sqlite_failed)?;
                    for reference in &refs {
                        sync_items::upsert_metadata_only(
                            &txn,
                            &reference.item_type,
                            &reference.item_id,
                            reference.modified_at,
                            None,
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

            let seen = next.as_deref().and_then(|c| c.parse::<u64>().ok());
            self.progress.progress(FirstSyncProgress {
                phase: FirstSyncPhase::Refs,
                completed: seen.unwrap_or(report.refs_recorded as u64),
                // §10.4's `tailCursor` when a session supplied one; otherwise
                // the tail is not knowable until the feed says `hasMore:
                // false`, and reporting the cursor against itself is the
                // honest answer rather than an invented denominator.
                total: seen
                    .unwrap_or(report.refs_recorded as u64)
                    .max(tail_cursor.max(0) as u64),
            });

            if !page.has_more {
                return Ok(());
            }
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
        let total = outstanding.len() as u64;
        let mut done = 0u64;

        for chunk in outstanding.chunks(METADATA_CHUNK) {
            let page = self.pull.fetch_ids(chunk).await?;
            report.metadata_applied += page.applied;
            report.metadata_corrupt += page.corrupt;
            done += chunk.len() as u64;
            self.progress.progress(FirstSyncProgress {
                phase: FirstSyncPhase::Metadata,
                completed: done,
                total,
            });
        }
        Ok(())
    }

    /// Pass three: bodies for the recent window.
    ///
    /// This is the pass that makes a note show its text. Everything above
    /// carries note *metadata*; a body edit's record push carries
    /// `content: null` (chapter 07's opening), so `yjs_updates` fills here or
    /// it never fills at all.
    async fn bodies_pass(
        &self,
        window_start: i64,
        report: &mut FirstSyncReport,
    ) -> Result<(), FirstSyncError> {
        let window = self
            .db
            .call(move |conn| recent_document_ids(conn, window_start))
            .await?;
        let total = window.len() as u64;

        for (done, doc_id) in window.iter().enumerate() {
            // §7.15: a tombstoned document is excluded by the query above.
            // The server still answers with the surviving log, and applying
            // it would resurrect a body the record feed says is deleted.
            report
                .bodies
                .absorb(self.bodies.pull_document(doc_id).await?);
            self.progress.progress(FirstSyncProgress {
                phase: FirstSyncPhase::Bodies,
                completed: done as u64 + 1,
                total,
            });
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

/// One `/sync/changes` ref row, reduced to what the refs pass records
/// (chapter 05 §5.11.1).
#[derive(Debug, Clone, PartialEq, Eq)]
struct RefRow {
    item_id: String,
    item_type: String,
    modified_at: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct RefsPage {
    refs: Vec<RefRow>,
    deleted: Vec<String>,
    has_more: bool,
    next_cursor: Option<String>,
}

/// Reads the page tolerantly: chapter 13 §13.2.2 permits ignoring an envelope
/// key a client does not know, and a missing array reads as empty.
fn read_refs_page(body: &Json) -> RefsPage {
    let refs = body
        .get("items")
        .and_then(Json::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    Some(RefRow {
                        item_id: item.get("id").and_then(Json::as_str)?.to_owned(),
                        item_type: item.get("type").and_then(Json::as_str)?.to_owned(),
                        modified_at: item
                            .get("modifiedAt")
                            .and_then(Json::as_i64)
                            .unwrap_or_default(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    RefsPage {
        refs,
        deleted: body
            .get("deleted")
            .and_then(Json::as_array)
            .map(|ids| {
                ids.iter()
                    .filter_map(Json::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default(),
        has_more: body.get("hasMore").and_then(Json::as_bool).unwrap_or(false),
        // §5.11.1: `nextCursor` is an integer on this route. A server that
        // spells it as a string means the same thing.
        next_cursor: match body.get("nextCursor") {
            Some(Json::String(text)) => Some(text.clone()),
            Some(Json::Number(number)) => Some(number.to_string()),
            _ => None,
        },
    }
}

/// The deletion instant for a tombstoned id: the ref row's `modifiedAt` when
/// the page carried one, and the local clock otherwise. A refs-only pass has
/// no envelope to read `deletedAt` from, and inventing a far-future instant
/// would outrank a real edit.
fn reference_now(refs: &[RefRow], item_id: &str) -> i64 {
    refs.iter()
        .find(|reference| reference.item_id == item_id)
        .map(|reference| reference.modified_at)
        .unwrap_or_else(now_ms)
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
    use serde_json::json;

    #[test]
    fn a_ref_page_keeps_the_type_and_the_modified_instant() {
        // §5.11.1's ref row. The refs pass needs `type` to file the row and
        // `modifiedAt` to order pass two, and needs nothing else.
        let page = read_refs_page(&json!({
            "items": [
                {"id": "abc123def456", "type": "note", "version": 3, "modifiedAt": 99, "size": 12},
                {"id": "no-type"}
            ],
            "deleted": ["gone1"],
            "hasMore": true,
            "nextCursor": 41
        }));
        assert_eq!(page.refs.len(), 1);
        assert_eq!(page.refs[0].item_type, "note");
        assert_eq!(page.refs[0].modified_at, 99);
        assert_eq!(page.deleted, ["gone1"]);
        assert!(page.has_more);
        assert_eq!(page.next_cursor.as_deref(), Some("41"));
    }

    #[test]
    fn a_page_missing_its_arrays_reads_as_empty_rather_than_failing() {
        let page = read_refs_page(&json!({}));
        assert!(page.refs.is_empty());
        assert!(page.deleted.is_empty());
        assert!(!page.has_more);
        assert_eq!(page.next_cursor, None);
    }

    #[test]
    fn the_window_is_thirty_days_and_the_body_cap_fits_sc_007() {
        assert_eq!(RECENT_WINDOW_MS, 2_592_000_000);
        // §10.6.1: 600 `crdt_pull` per minute unelevated, so the cap has to
        // stay under a minute of body pulling on its own or SC-007's two
        // minutes are gone before the refs and metadata passes are counted.
        assert_eq!(RECENT_BODY_LIMIT.min(600), RECENT_BODY_LIMIT);
    }
}
