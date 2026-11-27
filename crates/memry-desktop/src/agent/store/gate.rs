//! The entitlement gate of agent sync, the port of Electron's `agent/sync/entitlement-gate.ts`
//! and `backfill.ts`. A write queues its record only while the account is paid; a streaming
//! message is never queued. [`run_backfill`] queues what was written meanwhile on the first paid
//! verdict and on each turn from unpaid to paid, while the vault's backfill is pending
//! ([`agent_queue::backfill`]). A turn to unpaid leaves queued rows alone, as Electron does, and
//! marks the backfill pending.

use memry_core::domain::agent_queue::{self, Queue};
use memry_core::storage::Db;
use tokio::sync::watch;

/// Whether the account may sync agent records, read at each write.
#[derive(Clone)]
pub struct EntitlementGate(watch::Receiver<bool>);

impl EntitlementGate {
    pub fn new(paid: watch::Receiver<bool>) -> Self {
        Self(paid)
    }

    /// The queue of a write made now.
    pub fn queue(&self) -> Queue {
        if *self.0.borrow() {
            Queue::Outbox
        } else {
            Queue::LocalOnly
        }
    }
}

/// Queues the vault's agent records each time `paid` turns true, the current value included, and
/// returns when the sender is gone. The backfill runs on the database's single writer after the
/// turn, so every write that read the earlier verdict has committed and is found.
pub async fn run_backfill(mut paid: watch::Receiver<bool>, db: Db, vault_id: String) {
    loop {
        if paid.wait_for(|paid| *paid).await.is_err() {
            return;
        }
        let vault = vault_id.clone();
        match db
            .call(move |conn| agent_queue::backfill(conn, &vault, super::now_ms()))
            .await
        {
            Ok(queued) => tracing::info!(queued, "agent chat backfill queued records"),
            Err(error) => tracing::warn!(%error, "agent chat backfill failed"),
        }
        if paid.wait_for(|paid| !*paid).await.is_err() {
            return;
        }
        if let Err(error) = db
            .call(|conn| agent_queue::mark_backfill_pending(conn))
            .await
        {
            tracing::warn!(%error, "agent chat backfill could not be marked pending");
        }
    }
}
