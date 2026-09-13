//! The record pull loop, chapter 05 and data-model §C.3, §D.3 (FR-032).
//!
//! One page is: `GET /sync/changes` for the refs, `POST /sync/pull` for the
//! bodies of those refs **unioned with the page's `deleted` ids**, apply in
//! rank order, then advance the cursor. In that order and no other.
//!
//! Four rules shape every branch below, and three of them are about not losing
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
    /// Responses that were not a pull envelope at all (§5.14).
    pub dropped_pages: u32,
    /// The cursor now stored, after applying.
    pub cursor: Option<String>,
    pub has_more: bool,
    /// The breaker tripped: the run is unsuccessful and **no success state may
    /// be written**, even though the cursor advanced.
    pub refused: bool,
}

/// One page of `GET /sync/changes`.
///
/// Only the **ids** of the ref rows are kept. A ref's type is read from the
/// `/sync/pull` response instead, so a client never has two opinions about an
/// item's type, and the presence of a ref row is the only thing §5.12.1 needs
/// it for: an id in `deleted` **without** one has no type on the wire.
struct ChangesPage {
    ref_ids: Vec<String>,
    deleted: Vec<String>,
    has_more: bool,
    next_cursor: Option<String>,
}

/// The pull loop. One per vault; cheap to clone through the `Arc`s it holds.
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
    /// run that skipped it.
    pub async fn run(&self, max_pages: u32) -> Result<PullReport, PullError> {
        let mut total = PullReport::default();
        for _ in 0..max_pages {
            let page = self.pull_page().await?;
            total.pages += page.pages;
            total.applied += page.applied;
            total.deleted += page.deleted;
            total.skipped += page.skipped;
            total.corrupt += page.corrupt;
            total.expired += page.expired;
            total.dropped_pages += page.dropped_pages;
            total.cursor = page.cursor.clone();
            total.has_more = page.has_more;
            total.refused = page.refused;
            if page.refused || !page.has_more {
                break;
            }
        }
        Ok(total)
    }

    /// One page: refs, bodies, apply, advance.
    pub async fn pull_page(&self) -> Result<PullReport, PullError> {
        let cursor = self
            .db
            .call(|conn| store::read_cursor(conn, RECORD_CURSOR_SCOPE))
            .await?;

        let page = self.fetch_changes(cursor.as_deref()).await?;
        let mut report = PullReport {
            pages: 1,
            has_more: page.has_more,
            ..PullReport::default()
        };

        let ids = requested_ids(&page);
        let mut pending: Vec<Pending> = Vec::with_capacity(ids.len());
        let mut typed: Vec<String> = Vec::new();

        for chunk in ids.chunks(MAX_PULL_IDS) {
            let body = self.fetch_bodies(chunk).await?;
            let Some(items) = body.get("items").and_then(Json::as_array) else {
                // §5.14: not a pull envelope at all. The chunk is dropped and
                // the cursor still advances past it.
                report.dropped_pages += 1;
                continue;
            };
            for item in items {
                match self.decode(item) {
                    Ok(decoded) => {
                        typed.push(decoded.item_type().to_owned());
                        pending.push(decoded);
                    }
                    Err(corrupt) => {
                        report.corrupt += 1;
                        self.record_corrupt(item, &corrupt).await?;
                    }
                }
            }
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

        let outcomes = self.apply_all(pending, untyped).await?;
        report.applied += outcomes.applied;
        report.deleted += outcomes.deleted;
        report.skipped += outcomes.skipped;
        report.corrupt += outcomes.corrupt;
        report.expired += outcomes.expired;

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
        let outcomes = self.apply_all(pending, Vec::new()).await?;
        report.applied += outcomes.applied;
        report.deleted += outcomes.deleted;
        report.skipped += outcomes.skipped;
        report.corrupt += outcomes.corrupt;
        report.expired += outcomes.expired;
        Ok(report)
    }

    async fn fetch_changes(&self, cursor: Option<&str>) -> Result<ChangesPage, PullError> {
        let mut path = format!("/sync/changes?limit={PULL_PAGE_LIMIT}");
        if let Some(cursor) = cursor {
            path.push_str("&cursor=");
            path.push_str(cursor);
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
    /// applied at.
    async fn apply_all(
        &self,
        pending: Vec<Pending>,
        untyped: Vec<String>,
    ) -> Result<ApplyTotals, PullError> {
        let now = now_ms();
        Ok(self
            .db
            .call(move |conn| apply::apply_page(conn, pending, untyped, now))
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

/// §5.12: the client unions `deleted` into the `/sync/pull` request for the
/// **same** page, because tombstones arrive as full signed items.
fn requested_ids(page: &ChangesPage) -> Vec<String> {
    let mut ids: Vec<String> = Vec::with_capacity(page.ref_ids.len() + page.deleted.len());
    for id in page.ref_ids.iter().chain(page.deleted.iter()) {
        if !ids.iter().any(|kept| kept == id) {
            ids.push(id.clone());
        }
    }
    ids
}

fn typed_covers(pending: &[Pending], id: &str) -> bool {
    pending.iter().any(|item| item.item_id() == id)
}

/// Reads the page shape tolerantly: chapter 13 §13.2.2 permits ignoring an
/// **envelope** key a client does not know, and a missing `items` or `deleted`
/// array reads as empty rather than as a failure.
fn read_changes_page(body: &Json) -> ChangesPage {
    let ref_ids = body
        .get("items")
        .and_then(Json::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("id").and_then(Json::as_str))
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let deleted = body
        .get("deleted")
        .and_then(Json::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(Json::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    ChangesPage {
        ref_ids,
        deleted,
        has_more: body.get("hasMore").and_then(Json::as_bool).unwrap_or(false),
        // The cursor is a decimal string on the wire; a server that sends it
        // as a number means the same thing (§5.11).
        next_cursor: match body.get("nextCursor") {
            Some(Json::String(text)) => Some(text.clone()),
            Some(Json::Number(number)) => Some(number.to_string()),
            _ => None,
        },
    }
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

    #[test]
    fn the_requested_ids_union_the_refs_and_the_deleted_of_the_same_page() {
        let page = ChangesPage {
            ref_ids: vec!["a".into(), "b".into()],
            deleted: vec!["b".into(), "c".into()],
            has_more: false,
            next_cursor: None,
        };
        assert_eq!(requested_ids(&page), ["a", "b", "c"]);
    }

    #[test]
    fn a_page_shape_missing_its_arrays_reads_as_empty_rather_than_failing() {
        let page = read_changes_page(&json!({ "nextCursor": 41, "hasMore": true }));
        assert!(page.ref_ids.is_empty());
        assert!(page.deleted.is_empty());
        assert!(page.has_more);
        assert_eq!(page.next_cursor.as_deref(), Some("41"));
    }
}
