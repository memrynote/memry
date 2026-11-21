//! Record pack entries (chapter 08 §8.4.2) rebuilt as pull items go through
//! the decode and apply of [`PullLoop::fetch_ids`], so neither drifts from
//! the other.

use serde_json::Value as Json;

use super::{PullError, PullLoop, PullReport};
use crate::crypto::agent_envelope::AtRestKey;
use crate::protocol::types::ArrivingItemType;
use crate::sync::apply::{self, Pending};
use crate::sync::driver::observer::AppliedFeed;

impl PullLoop {
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
        let (outcomes, _) = self
            .apply_all(pending, Vec::new(), true, None, &mut feed)
            .await?;
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
