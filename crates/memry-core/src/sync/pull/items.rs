//! Decoding a page's items and fetching its note bodies: the pull loop's
//! halves that touch neither the cursor nor the apply.

use std::sync::Arc;

use serde_json::Value as Json;

use crate::sync::crypto_batch::off_runtime;

use super::{PullError, PullLoop, PullReport, now_ms};
use crate::storage::repositories::sync_items;
use crate::sync::apply::{self, Pending};
use crate::sync::changes_page::ChangesPage;
use crate::sync::note_body_feed::{self, FeedClient, FetchedBodies};
use crate::sync::pull_decode::{self, server_cursor};

impl PullLoop {
    /// Decodes pulled items per item (§5.14): each one is pending or one
    /// recorded corrupt item.
    pub(super) async fn take_items(
        &self,
        items: Vec<Json>,
        report: &mut PullReport,
        pending: &mut Vec<Pending>,
    ) -> Result<(), PullError> {
        for (item, decoded) in self.decode_batch(items).await? {
            match decoded {
                Ok(decoded) => pending.push(decoded),
                Err(corrupt) => {
                    report.corrupt += 1;
                    self.record_corrupt(&item, &corrupt).await?;
                }
            }
        }
        Ok(())
    }

    /// Opens and decodes `items`, in order, on `spawn_blocking`: a page's
    /// envelope opens and signature checks are CPU work that must not hold a
    /// runtime worker (#3534).
    pub(super) async fn decode_batch(
        &self,
        items: Vec<Json>,
    ) -> Result<Vec<(Json, Result<Pending, String>)>, PullError> {
        let declaration = self.declaration.clone();
        let cipher = Arc::clone(&self.cipher);
        let decoded = off_runtime("decoding a pulled page", move || {
            items
                .into_iter()
                .map(|item| {
                    let decoded = pull_decode::decode(&declaration, cipher.as_ref(), &item);
                    (item, decoded)
                })
                .collect()
        })
        .await?;
        Ok(decoded)
    }

    /// The `items` array of a `POST /sync/pull` body, taken out of it; `None`
    /// when the body is not a pull envelope (§5.14).
    pub(super) fn pulled_items(body: &mut Json) -> Option<Vec<Json>> {
        match body.get_mut("items").map(Json::take) {
            Some(Json::Array(items)) => Some(items),
            _ => None,
        }
    }

    /// [`note_body_feed::fetch`] for this page, when bodies are declared.
    ///
    /// The bodies dropped unfetched are those of a note or journal this page
    /// deletes: a typed tombstone of a document type, or an id in `deleted`
    /// with no typed item, which deletes every row under it (§5.12.1). A tag
    /// that shares a note's id deletes no body.
    pub(super) async fn fetch_note_bodies(
        &self,
        page: &ChangesPage,
        pending: &[Pending],
    ) -> Result<FetchedBodies, PullError> {
        let Some(cipher) = self.bodies.clone() else {
            return Ok(FetchedBodies::default());
        };
        let dropped: Vec<String> = page
            .deleted
            .iter()
            .filter(|id| {
                let typed: Vec<&Pending> = pending
                    .iter()
                    .filter(|item| item.item_id() == *id)
                    .collect();
                typed.is_empty()
                    || typed.iter().any(|item| {
                        matches!(item, Pending::Tombstone { .. })
                            && apply::DOCUMENT_TYPES.contains(&item.item_type())
                    })
            })
            .cloned()
            .collect();
        let entries = page.note_bodies.clone();
        let held = self
            .db
            .call(move |conn| note_body_feed::held_bodies(conn, entries.as_deref()))
            .await?;
        let request = |method: &str, path: &str| self.request(method, path);
        let client = FeedClient {
            http: &self.http,
            request: &request,
            cipher,
        };
        Ok(note_body_feed::fetch(&client, page.note_bodies.as_deref(), &dropped, &held).await)
    }

    /// Records a corrupt item against its row when the wire told us enough to
    /// find one (§5.14, chapter 13 §13.2 rule 5).
    ///
    /// An item so malformed that neither its id nor its type is readable is
    /// counted and nothing else: there is no row to flag, and inventing a key
    /// for it would put an unaddressable row in `sync_items` forever.
    pub(super) async fn record_corrupt(&self, item: &Json, reason: &str) -> Result<(), PullError> {
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
}
