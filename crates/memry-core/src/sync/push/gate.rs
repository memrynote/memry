//! Rows the push neither seals nor sends, though their outbox op is current.

use crate::storage::repositories::sync_items::SyncItemRow;
use crate::sync::outbox::{self, OutboxRow};
use crate::sync::unknown_signer;

use super::{Built, PushCoordinator, PushError};

impl PushCoordinator {
    /// - An edit of a row a verified delete removed retires: sealed from the
    ///   deleted row it is an `update` carrying `deletedAt`, which the server
    ///   applies as a write and so brings the item back (#5413, #5427).
    /// - An edit of a row whose last pulled record waits on an unknown signer
    ///   is held ([`unknown_signer::held`]).
    pub(super) async fn gate(
        &self,
        queued: &OutboxRow,
        row: &SyncItemRow,
    ) -> Result<Option<Built>, PushError> {
        if row.deleted_at.is_some() && queued.op != outbox::OP_DELETE {
            let reason = "an edit of a row a verified delete removed";
            return Ok(Some(Built::Retired(reason.to_owned())));
        }
        let held = unknown_signer::held(&self.db, queued).await?;
        Ok(held.map(Built::Held))
    }
}
