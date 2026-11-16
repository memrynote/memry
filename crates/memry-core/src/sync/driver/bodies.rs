//! The per-pass body calls of the desktop driver (#3534): the per-note pull of
//! every document owed one ([`body_step`]), then the foreign journal ids owed
//! to their canonical day ([`journal_day_merge`]). iOS's `sync_now` makes the
//! same two calls (`api/sync/pass.rs:162,165`).
//!
//! They run after the engine's pass, under the vault's pass gate again, so no
//! pass or snapshot runs between their steps. Neither takes the gate itself.
//! Unlike iOS, which calls them between its pull and its push, the merged
//! journal body and the tombstones they queue go out with the next pass's
//! push (the 60 s tick at the latest).
//!
//! A pass that did not reach the server (offline, a pull that failed or was
//! refused) runs neither: every debt stays owed for the next pass. A failure
//! here is a local storage failure; it is logged and the pass report stands.

use crate::sync::engine::PassReport;
use crate::sync::state::SyncState;
use crate::sync::{body_step, journal_day_merge};

use super::SyncDriver;

impl SyncDriver {
    pub(super) async fn pull_bodies(&self, pass: &PassReport) {
        if pass.pull_error.is_some()
            || matches!(pass.final_state, SyncState::Offline | SyncState::Refused)
        {
            return;
        }
        let _gate = self.engine.hold_gate().await;
        if let Err(error) = body_step::run(&self.db, &self.first.bodies).await {
            eprintln!("memry-core: the pass's body step failed; the debts stay owed: {error}");
        }
        let device_id = &self.snapshots.device_id;
        if let Err(error) = journal_day_merge::drain(&self.db, &self.first.bodies, device_id).await
        {
            eprintln!("memry-core: the journal day merges stay owed: {error}");
        }
    }
}
