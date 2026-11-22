//! The decode and apply a pulled item and a packed one share: the first
//! sync's by-id pulls ([`PullLoop::fetch_ids`]) and record pack entries
//! (chapter 08 §8.4.2) go through one path, so neither drifts from the other.

use serde_json::{Value as Json, json};

use crate::protocol::http::SYNC_TYPES_HEADER;
use crate::protocol::types::ArrivingItemType;
use crate::storage::nested_tx;

use super::{MAX_PULL_IDS, PullError, PullLoop, PullReport, apply_items, sqlite_failed};
use crate::sync::apply::{self, Pending};
use crate::sync::pull_decode::{Decoding, now_ms};

/// The feed-only token that makes `POST /sync/pull` serve purged markers
/// (`FEED_ONLY_SYNC_TYPES`, `packages/contracts/src/sync-api.ts:155`).
const PURGED_TOMBSTONES_SYNC_TYPE: &str = "purged_tombstones";

impl PullLoop {
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
        Ok(self.fetch_ids_declaring(ids, false).await?.0)
    }

    /// [`Self::fetch_ids`] that also declares `purged_tombstones` (chapter 05
    /// §5.12.3), so the server answers an id whose tombstone it shed with a
    /// marker instead of nothing. Answers the bodies' `purgedTombstones`
    /// entries unread: nothing here applies a marker. The manifest reconcile
    /// admits and verifies them against the rows it asked about.
    pub(crate) async fn fetch_ids_with_markers(
        &self,
        ids: &[String],
    ) -> Result<(PullReport, Vec<Json>), PullError> {
        self.fetch_ids_declaring(ids, true).await
    }

    async fn fetch_ids_declaring(
        &self,
        ids: &[String],
        markers: bool,
    ) -> Result<(PullReport, Vec<Json>), PullError> {
        let mut dropped_pages = 0;
        let mut entries = Vec::new();
        let decoder = self.decoder();
        let mut decoding = Vec::with_capacity(ids.len().div_ceil(MAX_PULL_IDS));
        for chunk in ids.chunks(MAX_PULL_IDS) {
            let mut body = if markers {
                let declared = format!(
                    "{},{PURGED_TOMBSTONES_SYNC_TYPE}",
                    self.declaration.header_value()
                );
                let request = self
                    .request("POST", "/sync/pull")
                    .header(SYNC_TYPES_HEADER, &declared)
                    .json(&json!({ "itemIds": chunk }));
                self.http.send_json::<Json>(request).await?
            } else {
                self.fetch_bodies(chunk).await?
            };
            let Some(items) = body.get_mut("items").and_then(Json::as_array_mut) else {
                dropped_pages += 1;
                continue;
            };
            decoding.push(decoder.spawn(std::mem::take(items)));
            if let Some(Json::Array(marked)) = body.get_mut("purgedTombstones") {
                entries.append(marked);
            }
        }
        let (mut report, failed) = self.apply_decoded(decoding).await?;
        report.dropped_pages = dropped_pages;
        for (item, reason) in failed {
            report.corrupt += 1;
            self.record_corrupt(&item, &reason).await?;
        }
        Ok((report, entries))
    }

    /// The signing key [`super::RecordCipher::signing_key`] resolves.
    pub(crate) fn signing_key(&self, device_id: &str) -> Option<Vec<u8>> {
        self.cipher.signing_key(device_id)
    }

    /// Whether this loop's declaration subscribes `item_type` (§5.3). A record
    /// pack is not filtered by the subscription, so its reader skips an
    /// undeclared entry as `POST /sync/pull` would never have served it
    /// (chapter 08 §8.4.2).
    pub(crate) fn declares(&self, item_type: &str) -> bool {
        self.declaration.classify(item_type) != ArrivingItemType::Undeclared
    }

    /// Applies pull items rebuilt from record pack entries (chapter 08
    /// §8.4.2) through the same decode and apply as [`Self::fetch_ids`], in one
    /// transaction. An item that fails to decode or verify is **not** recorded
    /// corrupt: it is answered back, and the caller leaves it item-granular.
    pub(crate) async fn apply_pack_items(
        &self,
        items: Vec<Json>,
    ) -> Result<(PullReport, Vec<Json>), PullError> {
        let decoding = vec![self.decoder().spawn(items)];
        let (report, failed) = self.apply_decoded(decoding).await?;
        Ok((report, failed.into_iter().map(|(item, _)| item).collect()))
    }

    /// The one apply a pulled item and a packed one share: per-item decode,
    /// §5.13's order, then every item in one transaction. Answers the items
    /// that did not decode, each with its reason.
    async fn apply_decoded(
        &self,
        decoding: Vec<Decoding>,
    ) -> Result<(PullReport, Vec<(Json, String)>), PullError> {
        let mut report = PullReport::default();
        let mut pending: Vec<Pending> = Vec::new();
        let mut failed = Vec::new();
        for chunk in decoding {
            for (item, decoded) in chunk.finish().await? {
                match decoded {
                    Ok(decoded) => pending.push(decoded),
                    Err(reason) => failed.push((item, reason)),
                }
            }
        }

        pending.sort_by_key(|item| apply::apply_rank(item.item_type()));
        let now = now_ms();
        let clock_device = self.clock_device.clone();
        let outcomes = self
            .db
            .call(move |conn| {
                let txn = nested_tx::begin(conn).map_err(sqlite_failed)?;
                let totals = apply_items(
                    &txn,
                    pending,
                    Vec::new(),
                    false,
                    now,
                    clock_device.as_deref(),
                )?;
                txn.commit().map_err(sqlite_failed)?;
                Ok(totals)
            })
            .await?;
        report.applied += outcomes.applied;
        report.deleted += outcomes.deleted;
        report.skipped += outcomes.skipped;
        report.corrupt += outcomes.corrupt;
        report.expired += outcomes.expired;
        report.purged_documents.extend(outcomes.purged_documents);
        Ok((report, failed))
    }
}
