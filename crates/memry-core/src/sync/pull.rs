//! The record pull loop, chapter 05 and data-model §C.3, §D.3 (FR-032).
//!
//! One page is: `GET /sync/changes` for the refs, `POST /sync/pull` for the
//! bodies of those refs **unioned with the page's `deleted` ids**, apply in
//! rank order, then advance the cursor. In that order and no other. The first
//! page of an incremental run asks for inline payloads (§5.11.2), and only the
//! ids no inline item names go to `POST /sync/pull`.
//!
//! Five rules shape every branch below, and four of them are about not losing
//! a user's data on a page that went wrong:
//!
//! - **One global record cursor per device** (§5.11), a decimal string,
//!   advanced to `nextCursor` **only after the page's items were applied**.
//!   Never a per-type cursor: the feed is one ordered stream. The `scope`
//!   column exists for `crdt:<docId>`, which is a different feed.
//! - **Schema validation is per item, never per page** (§5.14). One malformed
//!   item is recorded corrupt and skipped; it never poisons its 99 page mates.
//!   A whole-page parse drops the page, and on a first sync that wedges every
//!   item sharing a chunk with one bad row.
//! - **The breaker** (§5.14): a page that yielded nothing, produced at least
//!   one new corrupt item and asked for at least one id advances the cursor
//!   *and* refuses the run, so no success state is written. Advancing without
//!   refusing loses data silently; refusing without advancing wedges the device
//!   on one poisoned page forever. Both halves or neither.
//! - **A `/sync/pull` body that is not a pull envelope refuses the run and
//!   holds the cursor** (§5.14, #2285). That is a server fault, not a poisoned
//!   item: the page must still be there to re-pull once the server is fixed.
//! - **A tombstone's body is never decoded** (§5.12). A present `deletedAt`
//!   overrides the declared `operation`, and an id in `deleted` with no ref row
//!   has no type on the wire at all (§5.12.1).
//!
//! The loop never parses a payload into a typed struct: it hands the decrypted
//! bytes to [`super::apply::apply_page`], which chooses the item's merge
//! algorithm once (chapter 06 §6.8) and stores the bytes verbatim either way
//! (chapter 13 §13.2). **This file must not learn an item type's name**: the
//! one dispatch lives there, so that a route added later cannot forget it.

use std::sync::Arc;

use serde_json::{Value as Json, json};

use crate::api::errors::{ApiError, StorageError};
use crate::protocol::envelope::{self, EnvelopeError, RecordEnvelope, SyncOperation};
use crate::protocol::http::{ApiRequest, Auth, HttpClient, SYNC_TYPES_HEADER, VAULT_ID_HEADER};
use crate::protocol::types::{ArrivingItemType, Declaration};
use crate::storage::Db;
use crate::storage::repositories::sync_items::{self, InboundRecord};

use super::apply::{self, ApplyTotals, Pending};
use super::body_debt;
use super::changes_page::{ChangesPage, read_changes_page, requested_ids, uncovered_ids};
use super::store::{self, RECORD_CURSOR_SCOPE};

/// §5.10.2: a new client SHOULD request the server's ceiling. Five times fewer
/// round trips against the same rate-limit budget, and chapter 10 §10.6's
/// first-sync arithmetic assumes it. The server clamps rather than rejects, so
/// **a client MUST NOT infer its page size from what it asked for** (§5.10.1).
pub const PULL_PAGE_LIMIT: u32 = 500;

/// `POST /sync/pull` takes at most 100 ids (§5.10).
pub const MAX_PULL_IDS: usize = 100;

/// Opens one pulled envelope.
///
/// A seam rather than a direct call to [`envelope::decrypt`] because opening a
/// record needs the vault key **and** the signer's Ed25519 public key resolved
/// by `signerDeviceId` (chapter 04 §4.8, chapter 01 §1.4), and the key
/// directory is not this task's. The loop's job is to decide what a failure
/// here means, which is the same thing whatever supplies the keys: one corrupt
/// item, never a dropped page.
pub trait RecordCipher: Send + Sync {
    fn open(&self, envelope: &RecordEnvelope) -> Result<Vec<u8>, EnvelopeError>;
}

/// What a pull pass failed with. A per-item failure is **not** one of these:
/// it is a count in [`PullReport`].
#[derive(Debug, thiserror::Error)]
pub enum PullError {
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

/// What one pass did. Counts rather than a boolean, because the breaker needs
/// three separate facts about the same page.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PullReport {
    pub pages: u32,
    pub applied: usize,
    pub deleted: usize,
    /// Chapter 06 §6.3.1: the local clock dominated, so the remote was not
    /// applied. **Not corrupt and not nothing**: the item was processed, the
    /// cursor advances past it, and it counts as the page having yielded —
    /// or one legitimately skipped item on a page with one bad one would trip
    /// §5.14's breaker and refuse a run that did its work.
    pub skipped: usize,
    pub corrupt: usize,
    /// Past the 90-day `task_activity` horizon (chapter 13 §13.12). **Not
    /// corrupt**: the row is expired and the cursor still advances past it.
    pub expired: usize,
    /// Responses that were not a pull envelope at all (§5.14). Such a page
    /// holds the cursor and refuses the run (#2285).
    pub dropped_pages: u32,
    /// The cursor now stored, after applying.
    pub cursor: Option<String>,
    pub has_more: bool,
    /// The run is unsuccessful and **no success state may be written**:
    /// either the breaker tripped, and the cursor advanced, or a pull response
    /// was not an envelope, and the cursor held.
    pub refused: bool,
    /// The documents whose body log a tombstone on this pass actually emptied
    /// (chapter 07 §7.15).
    ///
    /// §7.15's first consequence has two halves and this loop can only do one
    /// of them. The local update log and both snapshot rows are gone by the
    /// time this is read; the **in-memory** `Y.Doc` is not, because the pull
    /// owns no [`crate::crdt::DocumentRegistry`]. A caller that holds one
    /// releases each id here. Reporting them is the point: a purge that left
    /// the caller believing the body was gone everywhere would be worse than
    /// one that failed loudly.
    pub purged_documents: Vec<String>,
}

/// The pull loop. One per vault; cheap to clone through the `Arc`s it holds.
/// The declaration header value the record cursor was last advanced under.
pub const META_RECORD_DECLARATION: &str = "sync.record_declaration";

pub struct PullLoop {
    http: Arc<HttpClient>,
    db: Db,
    declaration: Declaration,
    cipher: Arc<dyn RecordCipher>,
    vault_id: Option<String>,
}

impl PullLoop {
    pub fn new(
        http: Arc<HttpClient>,
        db: Db,
        declaration: Declaration,
        cipher: Arc<dyn RecordCipher>,
    ) -> Self {
        Self {
            http,
            db,
            declaration,
            cipher,
            vault_id: None,
        }
    }

    /// The client every record call goes out through. Public for the same
    /// reason [`PullLoop::request`] is: the first-sync sub-sequence drives
    /// `/sync/changes` itself and must not build a second client.
    pub fn http(&self) -> &HttpClient {
        &self.http
    }

    /// The `X-Memry-Vault-Id` header's value, when a vault is selected (§5.2).
    pub fn with_vault(mut self, vault_id: &str) -> Self {
        self.vault_id = Some(vault_id.to_owned());
        self
    }

    /// Drains up to `max_pages` pages, stopping at the end of the feed or at
    /// the first refusal.
    ///
    /// A refusal stops the loop deliberately: the cursor has moved past a page
    /// that produced only corruption, and continuing would report a successful
    /// run that skipped it. After a non-envelope pull body the cursor held, and
    /// continuing would re-read the same page.
    pub async fn run(&self, max_pages: u32) -> Result<PullReport, PullError> {
        self.restart_on_new_declaration().await?;
        let mut total = PullReport::default();
        for index in 0..max_pages {
            let page = if index == 0 {
                self.pull_first_page().await?
            } else {
                self.pull_page().await?
            };
            total.pages += page.pages;
            total.applied += page.applied;
            total.deleted += page.deleted;
            total.skipped += page.skipped;
            total.corrupt += page.corrupt;
            total.expired += page.expired;
            total.dropped_pages += page.dropped_pages;
            total
                .purged_documents
                .extend(page.purged_documents.iter().cloned());
            total.cursor = page.cursor.clone();
            total.has_more = page.has_more;
            total.refused = page.refused;
            if page.refused || !page.has_more {
                break;
            }
        }
        Ok(total)
    }

    /// Whether the stored record cursor is at or past `cursor`. `false` when
    /// there is no cursor or it will not read: pulling is the safe answer.
    pub async fn has_applied_through(&self, cursor: i64) -> bool {
        let stored = self
            .db
            .call(|conn| store::read_cursor(conn, RECORD_CURSOR_SCOPE))
            .await;
        let applied = stored
            .ok()
            .flatten()
            .and_then(|text| text.parse::<i64>().ok());
        applied.is_some_and(|applied| cursor <= applied)
    }

    /// Starts the feed over once when the declared types grew.
    ///
    /// The record cursor is one position in one feed, and the server filters
    /// that feed by the declaration. A type added to the declaration later
    /// (saved filters, spec 004 TP022) has rows *behind* the stored cursor
    /// that this device never saw, and no later page will carry them. The
    /// declaration a device last pulled under is kept in `meta`; when the
    /// current one differs, or a device that has pulled before never recorded
    /// one, the cursor goes back to the start and the next pages re-read the
    /// feed. Re-applying a known item is a no-op merge (its clocks dominate or
    /// match), so the cost is one full pull, once.
    async fn restart_on_new_declaration(&self) -> Result<(), PullError> {
        let current = self.declaration.header_value();
        self.db
            .call(move |conn| {
                let stored = super::first_sync_store::read_meta(conn, META_RECORD_DECLARATION)?;
                if stored.as_deref() == Some(current.as_str()) {
                    return Ok(());
                }
                if store::read_cursor(conn, RECORD_CURSOR_SCOPE)?.is_some() {
                    store::write_cursor(conn, RECORD_CURSOR_SCOPE, None, now_ms())?;
                }
                super::first_sync_store::write_meta(conn, META_RECORD_DECLARATION, &current)
            })
            .await?;
        Ok(())
    }

    /// One page: refs, bodies, apply, advance.
    pub async fn pull_page(&self) -> Result<PullReport, PullError> {
        self.page(false).await
    }

    /// The first page of a run. When a cursor is stored the pull is
    /// incremental, so it asks `GET /sync/changes?inline=1` (chapter 05
    /// §5.11.2, #2292) and a small page applies without a `POST /sync/pull`.
    /// With no cursor the feed is read from the start, which is backlog and
    /// keeps 500-ref pages. A server that ignores the query sends no `inline`
    /// and the page is pulled exactly as [`PullLoop::pull_page`] pulls it.
    pub async fn pull_first_page(&self) -> Result<PullReport, PullError> {
        self.page(true).await
    }

    async fn page(&self, ask_inline: bool) -> Result<PullReport, PullError> {
        let cursor = self
            .db
            .call(|conn| store::read_cursor(conn, RECORD_CURSOR_SCOPE))
            .await?;

        let inline = ask_inline && cursor.is_some();
        let page = self.fetch_changes(cursor.as_deref(), inline).await?;
        let mut report = PullReport {
            pages: 1,
            has_more: page.has_more,
            ..PullReport::default()
        };

        let ids = requested_ids(&page);
        let mut pending: Vec<Pending> = Vec::with_capacity(ids.len());

        let fetch = uncovered_ids(&page, &ids);

        self.take_items(&page.inline, &mut report, &mut pending)
            .await?;
        for chunk in fetch.chunks(MAX_PULL_IDS) {
            let body = self.fetch_bodies(chunk).await?;
            let Some(items) = body.get("items").and_then(Json::as_array) else {
                // §5.14 (#2285): not a pull envelope at all, which is a server
                // contract regression. Nothing from the page is applied and the
                // cursor holds, so the page is still there to re-pull once the
                // server is fixed; the run is refused so no success is written.
                report.dropped_pages += 1;
                report.refused = true;
                report.cursor = cursor;
                return Ok(report);
            };
            self.take_items(items, &mut report, &mut pending).await?;
        }

        // §5.13: rank, then a **stable** sort, so two items of the same rank
        // keep the order the server sent them in. `sort_by_key` is stable.
        pending.sort_by_key(|item| apply_rank(item.item_type()));

        // §5.12.1: an id in `deleted` with no ref row, and for which the pull
        // returned no typed item either, has no type on the wire. It is not an
        // error and it does not stop the page.
        let untyped: Vec<String> = page
            .deleted
            .iter()
            .filter(|id| !page.ref_ids.contains(id) && !typed_covers(&pending, id))
            .cloned()
            .collect();

        let outcomes = self.apply_all(pending, untyped, true).await?;
        report.applied += outcomes.applied;
        report.deleted += outcomes.deleted;
        report.skipped += outcomes.skipped;
        report.corrupt += outcomes.corrupt;
        report.expired += outcomes.expired;
        report.purged_documents.extend(outcomes.purged_documents);

        // §5.11: only now.
        let now = now_ms();
        let advanced = page.next_cursor.clone().or(cursor);
        let stored = advanced.clone();
        self.db
            .call(move |conn| {
                store::write_cursor(conn, RECORD_CURSOR_SCOPE, stored.as_deref(), now)
            })
            .await?;
        report.cursor = advanced;

        // §5.14's breaker, all three conditions or none.
        let yielded = report.applied + report.deleted + report.skipped + report.expired;
        report.refused = yielded == 0 && report.corrupt > 0 && !ids.is_empty();

        Ok(report)
    }

    /// Fetches, decodes and applies a named set of ids, **without touching
    /// the record cursor**.
    ///
    /// The first sync's metadata pass (T122) drives this: its work list is
    /// the `payload_state = 'metadata-only'` rows the refs pass recorded, not
    /// a position in the feed, so there is no cursor to move and §5.14's page
    /// breaker — which is about a page of the feed — does not apply. Every
    /// other rule does: per-item validation, the §5.13 apply order, and one
    /// corrupt item never poisoning its chunk mates.
    pub async fn fetch_ids(&self, ids: &[String]) -> Result<PullReport, PullError> {
        let mut report = PullReport::default();
        let mut pending: Vec<Pending> = Vec::with_capacity(ids.len());

        for chunk in ids.chunks(MAX_PULL_IDS) {
            let body = self.fetch_bodies(chunk).await?;
            let Some(items) = body.get("items").and_then(Json::as_array) else {
                report.dropped_pages += 1;
                continue;
            };
            for item in items {
                match self.decode(item) {
                    Ok(decoded) => pending.push(decoded),
                    Err(corrupt) => {
                        report.corrupt += 1;
                        self.record_corrupt(item, &corrupt).await?;
                    }
                }
            }
        }

        pending.sort_by_key(|item| apply_rank(item.item_type()));
        let outcomes = self.apply_all(pending, Vec::new(), false).await?;
        report.applied += outcomes.applied;
        report.deleted += outcomes.deleted;
        report.skipped += outcomes.skipped;
        report.corrupt += outcomes.corrupt;
        report.expired += outcomes.expired;
        report.purged_documents.extend(outcomes.purged_documents);
        Ok(report)
    }

    /// Decodes pulled items per item (§5.14): each one is pending or one
    /// recorded corrupt item.
    async fn take_items(
        &self,
        items: &[Json],
        report: &mut PullReport,
        pending: &mut Vec<Pending>,
    ) -> Result<(), PullError> {
        for item in items {
            match self.decode(item) {
                Ok(decoded) => pending.push(decoded),
                Err(corrupt) => {
                    report.corrupt += 1;
                    self.record_corrupt(item, &corrupt).await?;
                }
            }
        }
        Ok(())
    }

    async fn fetch_changes(
        &self,
        cursor: Option<&str>,
        inline: bool,
    ) -> Result<ChangesPage, PullError> {
        let mut path = format!("/sync/changes?limit={PULL_PAGE_LIMIT}");
        if let Some(cursor) = cursor {
            path.push_str("&cursor=");
            path.push_str(cursor);
        }
        if inline {
            path.push_str("&inline=1");
        }
        let body: Json = self.http.send_json(self.request("GET", &path)).await?;
        Ok(read_changes_page(&body))
    }

    async fn fetch_bodies(&self, ids: &[String]) -> Result<Json, PullError> {
        let request = self
            .request("POST", "/sync/pull")
            .json(&json!({ "itemIds": ids })); // §5.11.1, defect 50
        Ok(self.http.send_json(request).await?)
    }

    /// The request every record call is built from: session auth plus §5.3's
    /// negotiation header plus the vault. Public so the first-sync
    /// sub-sequence ([`super::first_sync`]) drives `/sync/changes` with the
    /// identical header set rather than a second, drifting copy of it.
    pub fn request(&self, method: &str, path: &str) -> ApiRequest {
        let mut request = ApiRequest::new(method, path)
            .auth(Auth::Session)
            // §5.3: negotiation is a header, not a query parameter.
            .header(SYNC_TYPES_HEADER, &self.declaration.header_value());
        if let Some(vault_id) = &self.vault_id {
            request = request.header(VAULT_ID_HEADER, vault_id);
        }
        request
    }

    /// Per-item validation. Every `Err` here is **one** corrupt item.
    fn decode(&self, item: &Json) -> Result<Pending, String> {
        let envelope =
            envelope::from_json(item).map_err(|error| format!("malformed envelope: {error}"))?;

        // §5.3.1: a type this client did not declare is recorded, not applied.
        // The record feed cannot produce it today; the rule is defensive.
        if self.declaration.classify(&envelope.item_type) == ArrivingItemType::Undeclared {
            return Err(format!("undeclared item type `{}`", envelope.item_type));
        }

        // §5.12: a present `deletedAt` overrides the declared operation, and
        // the body is never decoded.
        let deleted_at = envelope
            .deleted_at
            .or_else(|| (envelope.operation == SyncOperation::Delete).then(now_ms));
        if let Some(deleted_at) = deleted_at {
            return Ok(Pending::Tombstone {
                item_type: envelope.item_type.clone(),
                item_id: envelope.id.clone(),
                deleted_at,
                server_cursor: server_cursor(item),
            });
        }

        let plaintext = self
            .cipher
            .open(&envelope)
            .map_err(|error| format!("could not open the record: {error}"))?;
        let payload_json = String::from_utf8(plaintext)
            .map_err(|_| "the decrypted payload is not UTF-8".to_owned())?;

        Ok(Pending::Record(InboundRecord {
            item_type: envelope.item_type,
            item_id: envelope.id,
            payload_json,
            server_cursor: server_cursor(item),
            signer_device_id: Some(envelope.signer_device_id),
            updated_at: now_ms(),
            deleted_at: None,
        }))
    }

    /// Records a corrupt item against its row when the wire told us enough to
    /// find one (§5.14, chapter 13 §13.2 rule 5).
    ///
    /// An item so malformed that neither its id nor its type is readable is
    /// counted and nothing else: there is no row to flag, and inventing a key
    /// for it would put an unaddressable row in `sync_items` forever.
    async fn record_corrupt(&self, item: &Json, reason: &str) -> Result<(), PullError> {
        let (Some(item_id), Some(item_type)) = (
            item.get("id").and_then(Json::as_str),
            item.get("type").and_then(Json::as_str),
        ) else {
            return Ok(());
        };
        let item_id = item_id.to_owned();
        let item_type = item_type.to_owned();
        let reason = reason.to_owned();
        let cursor = server_cursor(item);
        let now = now_ms();
        self.db
            .call(move |conn| {
                sync_items::upsert_metadata_only(conn, &item_type, &item_id, now, cursor)?;
                sync_items::mark_corrupt(conn, &item_type, &item_id, &reason, now)
            })
            .await?;
        Ok(())
    }

    /// Hands the page to [`apply`], which owns every decision about what an
    /// item's type means. The loop's only remaining job is the clock it is
    /// applied at, and on a feed page the body debt of its documents.
    ///
    /// The debt is written **before** the apply (#2294): a page re-pulled
    /// after a crash skips its identical records (chapter 06 §6.5.2 P4), so a
    /// debt written after them would be lost with the crash. A debt this page
    /// created for a record it then skipped is taken back; one an earlier
    /// page left is kept.
    async fn apply_all(
        &self,
        pending: Vec<Pending>,
        untyped: Vec<String>,
        owe_bodies: bool,
    ) -> Result<ApplyTotals, PullError> {
        let now = now_ms();
        Ok(self
            .db
            .call(move |conn| {
                let owed_here = if owe_bodies {
                    body_debt::owe_page(conn, &pending)?
                } else {
                    Vec::new()
                };
                let totals = apply::apply_page(conn, pending, untyped, now)?;
                for doc_id in &owed_here {
                    if !totals.applied_documents.contains(doc_id) {
                        body_debt::settle(conn, doc_id)?;
                    }
                }
                Ok(totals)
            })
            .await?)
    }
}

/// §5.13's `PULL_APPLY_ORDER`. **Everything unlisted is rank 1.**
pub fn apply_rank(item_type: &str) -> u8 {
    match item_type {
        "project" | "folder_config" | "tag_definition" | "filter" | "settings"
        | "calendar_source" | "agent_conversation" => 0,
        "task" | "agent_message" | "calendar_event" | "calendar_external_event" => 2,
        "calendar_binding" => 3,
        _ => 1,
    }
}

fn typed_covers(pending: &[Pending], id: &str) -> bool {
    pending.iter().any(|item| item.item_id() == id)
}

fn server_cursor(item: &Json) -> Option<i64> {
    item.get("serverCursor").and_then(Json::as_i64)
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
    fn the_apply_order_ranks_the_four_tiers_and_defaults_to_one() {
        assert_eq!(apply_rank("project"), 0);
        assert_eq!(apply_rank("note"), 1);
        assert_eq!(apply_rank("hologram"), 1);
        assert_eq!(apply_rank("task"), 2);
        assert_eq!(apply_rank("calendar_binding"), 3);
    }
}
