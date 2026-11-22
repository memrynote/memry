//! The push wave's half of a row the server holds deleted (chapter 05 §5.8,
//! #5406): the calls into [`delete_wins`] and the per-item deferral when one
//! fails. A failure defers that item and never the wave.

use crate::api::errors::StorageError;
use crate::sync::outbox::{self, Collapsed};
use crate::sync::{delete_wins, unknown_signer};

use super::{PushCoordinator, PushError, PushReport, now_ms, retry_at};

impl PushCoordinator {
    /// An upsert of a row the reconcile kept against an unattested marker
    /// applies that delete here instead of being sent ([`delete_wins`]).
    pub(super) async fn applies_kept_marker(&self, item: &Collapsed) -> Result<bool, StorageError> {
        let (item, device, now) = (item.clone(), self.clock_device.clone(), now_ms());
        let apply = move |conn: &mut _| delete_wins::apply_kept_marker(conn, &item, &device, now);
        self.db.call(apply).await
    }

    /// An upsert of a row whose last pulled record waits on an unknown signer
    /// ([`unknown_signer::holds`]) is deferred, not sent: that record may be a
    /// delete the server would let this edit reverse (#5413).
    pub(super) async fn held_for_unknown_signer(
        &self,
        item: &Collapsed,
    ) -> Result<bool, PushError> {
        if item.row.op != outbox::OP_UPSERT {
            return Ok(false);
        }
        let (item_type, item_id) = (item.row.item_type.clone(), item.row.item_id.clone());
        let holds = move |conn: &mut _| unknown_signer::holds(conn, &item_type, &item_id);
        if !self.db.call(holds).await? {
            return Ok(false);
        }
        let (ids, at) = (item.ids(), retry_at(now_ms(), item.row.attempt_count));
        let reason = "held: its last pulled record waits on an unknown signer";
        self.db
            .call(move |conn| outbox::defer(conn, &ids, reason, Some(at)))
            .await?;
        Ok(true)
    }

    /// The items the server answered `SYNC_DELETE_WINS`, one at a time.
    pub(super) async fn settle_delete_wins(
        &self,
        lost: Vec<Collapsed>,
        now: i64,
        report: &mut PushReport,
    ) -> Result<(), PushError> {
        for item in lost {
            match self.settle_one(&item, now).await {
                Ok(deleted) => {
                    report.accepted += item.ids().len();
                    report.deleted_locally += usize::from(deleted);
                }
                Err(error) => {
                    self.defer_unsettled(&item, &error).await?;
                    report.rejected += 1;
                }
            }
        }
        Ok(())
    }

    /// `SYNC_DELETE_WINS` for one item: pulls its id with markers, then
    /// deletes only on verified evidence ([`delete_wins::apply_delete_wins`]).
    async fn settle_one(&self, item: &Collapsed, now: i64) -> Result<bool, String> {
        let entries = match &self.pull {
            Some(pull) => {
                let ids = [item.row.item_id.clone()];
                let (_, entries) = pull
                    .fetch_ids_with_markers(&ids)
                    .await
                    .map_err(|e| e.to_string())?;
                entries
            }
            None => Vec::new(),
        };
        let (item, pull, device) = (item.clone(), self.pull.clone(), self.clock_device.clone());
        self.db
            .call(move |conn| {
                delete_wins::apply_delete_wins(conn, &item, &entries, pull.as_deref(), &device, now)
            })
            .await
            .map_err(|e| e.to_string())
    }

    /// An item whose local delete could not be decided or applied (an
    /// unreadable body, a failed pull): logged, deferred, nothing deleted.
    pub(super) async fn defer_unsettled(
        &self,
        item: &Collapsed,
        error: &str,
    ) -> Result<(), PushError> {
        let (item_type, item_id) = (&item.row.item_type, &item.row.item_id);
        eprintln!("memry-core: push: {item_type}:{item_id} deferred, nothing deleted: {error}");
        let (ids, reason) = (item.ids(), format!("{item_type}:{item_id}: {error}"));
        let at = retry_at(now_ms(), item.row.attempt_count);
        self.db
            .call(move |conn| outbox::defer(conn, &ids, &reason, Some(at)))
            .await?;
        Ok(())
    }
}
