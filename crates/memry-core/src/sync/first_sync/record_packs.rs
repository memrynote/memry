//! The record pack phase of the first sync (chapter 08 §8.4.2, §8.10, #5232).
//! Split out of [`super`] at the line ceiling.

use std::sync::Arc;

use crate::storage::nested_tx;

use super::super::first_sync_store::{read_meta, write_meta};
use super::super::store::{self, RECORD_CURSOR_SCOPE};
use super::{
    FirstSync, FirstSyncError, FirstSyncPhase, FirstSyncProgress, FirstSyncReport,
    META_FIRST_SYNC_RECORD_PACKS, now_ms, sqlite_failed,
};

impl FirstSync {
    /// Records from `record` packs, once, on a device that holds no record
    /// cursor yet. Answers whether any record pack is held, which makes the
    /// manifest reconcile due.
    ///
    /// The record cursor moves to the packs' tail start (§8.10) in the
    /// transaction that ends the phase, so a run killed before it repeats the
    /// phase (finished packs are not downloaded again) and one killed after it
    /// tails the feed from there.
    pub(super) async fn record_packs_pass(
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
                let progress = Arc::clone(&self.progress);
                let on_progress = move |completed: u64, total: u64| {
                    progress.progress(FirstSyncProgress {
                        phase: FirstSyncPhase::Metadata,
                        completed,
                        total: total.max(completed),
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
}
