//! Record pack entries (chapter 08 §8.4.2) rebuilt as pull items go through
//! the decode and apply of [`PullLoop::fetch_ids`], so neither drifts from
//! the other.

use serde_json::{Value as Json, json};

use super::{MAX_PULL_IDS, PullError, PullLoop, PullReport, typed_covers};
use crate::api::errors::StorageError;
use crate::crypto::agent_envelope::AtRestKey;
use crate::protocol::http::SYNC_TYPES_HEADER;
use crate::protocol::types::{ArrivingItemType, PURGED_TOMBSTONES_SYNC_TYPE};
use crate::sync::apply::{self, Pending};
use crate::sync::driver::observer::AppliedFeed;
use crate::sync::hardening::purged;

/// What `POST /sync/pull` answered for a named set of ids, nothing applied.
pub(super) struct IdItems {
    pub report: PullReport,
    pub pending: Vec<Pending>,
    /// The markers admitted for the pull's own rule ([`purged::applicable`]).
    pub markers: purged::Entries,
    /// The raw `purgedTombstones` entries of a request that declared them.
    pub entries: Vec<Json>,
    /// The ids of the chunks answered with a pull envelope.
    pub answered: Vec<String>,
}

impl PullLoop {
    /// The decoded items and the purged markers `POST /sync/pull` answers
    /// for `ids`, nothing applied yet. `with_markers` declares
    /// `purged_tombstones` on the request whatever the loop declares (chapter
    /// 05 §5.12.3), so the server answers an id whose tombstone it shed with a
    /// marker instead of nothing; those entries are answered raw in
    /// [`IdItems::entries`] and none is admitted for the pull's own rule.
    pub(super) async fn fetch_id_items(
        &self,
        ids: &[String],
        with_markers: bool,
    ) -> Result<IdItems, PullError> {
        let mut report = PullReport::default();
        let mut pending: Vec<Pending> = Vec::with_capacity(ids.len());
        let mut markers = purged::Entries::default();
        let mut entries = Vec::new();
        // A chunk with no envelope is a server fault counted in
        // `dropped_pages`, so only the answered chunks' ids can be uncovered.
        let mut answered: Vec<String> = Vec::with_capacity(ids.len());
        // Each chunk decodes while the next one's request is out (#5231).
        let mut decoding = Vec::with_capacity(ids.len().div_ceil(MAX_PULL_IDS));
        for chunk in ids.chunks(MAX_PULL_IDS) {
            let mut body = if with_markers {
                let declared = format!(
                    "{},{PURGED_TOMBSTONES_SYNC_TYPE}",
                    self.declaration.header_value_without_purged_tombstones()
                );
                let request = self
                    .request("POST", "/sync/pull")
                    .header(SYNC_TYPES_HEADER, &declared)
                    .json(&json!({ "itemIds": chunk }));
                self.http.send_json::<Json>(request).await?
            } else {
                let body = self.fetch_bodies(chunk).await?;
                markers.read(&body, chunk);
                body
            };
            let Some(items) = Self::pulled_items(&mut body) else {
                report.dropped_pages += 1;
                continue;
            };
            answered.extend_from_slice(chunk);
            if with_markers && let Some(Json::Array(marked)) = body.get_mut("purgedTombstones") {
                entries.append(marked);
            }
            decoding.push(self.start_items(items, &mut report).await?);
        }
        // A v2 attestation names this vault: checked as v1 only, a valid
        // marker is refused and its row kept (chapter 04 §4.8.4, #5247). The
        // ids are held instead, as for a failed pull.
        if self.vault_id().is_none()
            && entries
                .iter()
                .any(|e| e.get("deleteAttestation").and_then(Json::as_str).is_some())
        {
            return Err(StorageError::Failed {
                what: "a purged marker is attested and this pull has no vault id to check it in"
                    .to_owned(),
            }
            .into());
        }
        pending.extend(self.take_decoded(decoding, &mut report).await?);
        Ok(IdItems {
            report,
            pending,
            markers,
            entries,
            answered,
        })
    }

    /// Applies what [`Self::fetch_id_items`] decoded, in §5.13's order.
    pub(super) async fn apply_fetched(
        &self,
        mut report: PullReport,
        mut pending: Vec<Pending>,
    ) -> Result<PullReport, PullError> {
        pending.sort_by_key(|item| apply::apply_rank(item.item_type()));
        let mut feed = AppliedFeed::default();
        let (outcomes, _) = self.apply_all(pending, true, None, &mut feed).await?;
        self.tell(feed).await;
        report.applied += outcomes.applied;
        report.deleted += outcomes.deleted;
        report.skipped += outcomes.skipped;
        report.corrupt += outcomes.corrupt;
        report.expired += outcomes.expired;
        report.purged_documents.extend(outcomes.purged_documents);
        Ok(report)
    }

    /// The signing key [`super::RecordCipher::signing_key`] resolves.
    pub(crate) fn signing_key(&self, device_id: &str) -> Option<Vec<u8>> {
        self.cipher.signing_key(device_id)
    }

    /// [`Self::fetch_ids`] that also declares `purged_tombstones` (chapter 05
    /// §5.12.3), so the server answers an id whose tombstone it shed with a
    /// marker instead of nothing. Applies the pulled items but answers the
    /// bodies' `purgedTombstones` entries unread: the manifest reconcile
    /// admits and verifies them against the rows it asked about
    /// ([`crate::sync::purged_markers`]).
    pub(crate) async fn fetch_ids_with_markers(
        &self,
        ids: &[String],
    ) -> Result<(PullReport, Vec<Json>), PullError> {
        let IdItems {
            mut report,
            pending,
            entries,
            answered,
            ..
        } = self.fetch_id_items(ids, true).await?;
        report.uncovered = answered
            .iter()
            .filter(|id| !typed_covers(&pending, id))
            .count();
        Ok((self.apply_fetched(report, pending).await?, entries))
    }

    /// The key a record applied outside a pull page is sealed under: the
    /// manifest reconcile's removals.
    pub(crate) fn at_rest_key(&self) -> AtRestKey {
        self.at_rest.clone()
    }

    /// The vault folder a delete reads a note's file in, as the pull's own
    /// deletes do ([`PullLoop::with_vault_root`]).
    pub(crate) fn vault_root(&self) -> Option<std::path::PathBuf> {
        self.vault_root.clone()
    }

    /// Whether this loop's declaration subscribes `item_type` (§5.3). A record
    /// pack is not filtered by the subscription, so its reader skips an
    /// undeclared entry as `POST /sync/pull` would never have served it
    /// (chapter 08 §8.4.2).
    pub(crate) fn declares(&self, item_type: &str) -> bool {
        self.declaration.classify(item_type) != ArrivingItemType::Undeclared
    }

    /// Applies pull items rebuilt from record pack entries through the same
    /// decode and apply as [`Self::fetch_ids`], in one transaction. An item
    /// that fails to decode or verify is **not** recorded corrupt: it is
    /// answered back, and the caller leaves it item-granular.
    pub(crate) async fn apply_pack_items(
        &self,
        items: Vec<Json>,
    ) -> Result<(PullReport, Vec<Json>), PullError> {
        let mut report = PullReport::default();
        let items = self.skip_quarantined(items, &mut report).await?;
        let mut pending: Vec<Pending> = Vec::with_capacity(items.len());
        let mut failed = Vec::new();
        for (item, decoded) in self.decode_batch(items).await? {
            match decoded {
                Ok(decoded) => pending.push(decoded),
                Err(_) => failed.push(item),
            }
        }
        pending.sort_by_key(|item| apply::apply_rank(item.item_type()));
        let mut feed = AppliedFeed::default();
        let (outcomes, _) = self.apply_all(pending, true, None, &mut feed).await?;
        self.tell(feed).await;
        report.applied += outcomes.applied;
        report.deleted += outcomes.deleted;
        report.skipped += outcomes.skipped;
        report.corrupt += outcomes.corrupt;
        report.expired += outcomes.expired;
        report.purged_documents.extend(outcomes.purged_documents);
        Ok((report, failed))
    }
}
