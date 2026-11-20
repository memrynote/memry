//! Pulled changes to the open vault's disk (#3534 L5): the write-back and lock observer of the
//! sync driver, registered for the vault the supervisor syncs.
//!
//! - **Bodies.** Every note or journal day whose record or body a committed page changed is
//!   scheduled for the write-back ([`VaultTier::schedule`], Step 12's contract
//!   3534#6469737347). The write-back's own rules decide what reaches the file: a file changed
//!   outside the app since its last read is kept, and a file it replaces is kept as a version
//!   first. A crash before the schedule loses nothing: the next open's reconcile writes every
//!   file left behind its body.
//! - **Owed files.** When the pass's body step settled its debts (`bodies_settled`), every owed
//!   file is taken ([`VaultTier::take_owed_file`]), which schedules its write-back. Not on
//!   `bodies_applied`: the core tells that one before the pulled document's debt settles, so the
//!   take would still find the body owed.
//! - **Locks.** A pulled `vault_lock` record brings the disk in line with the locks
//!   ([`Locks::reconcile`], Electron's `onRemoteVaultLockApplied`). The reconcile takes no rows'
//!   lane and no editor lock, so it cannot wait on a writer that waits on this pass.
//!
//! Every call runs on the driver's blocking pool after its page committed, under the pass gate;
//! nothing here awaits a pass.

use std::path::PathBuf;
use std::sync::Arc;

use memry_core::api::vault::Vault;
use memry_core::sync::driver::{AppliedOutcome, AppliedRecord, ApplyObserver};

use crate::locks::Locks;
use crate::vault::consumer::VaultTier;

const SCOPE: &str = "sync_disk";

/// The record types whose files the write-back writes.
const FILE_TYPES: [&str; 2] = ["note", "journal"];
const LOCK_TYPE: &str = "vault_lock";

/// The disk side of one synced vault.
pub struct DiskObserver {
    tier: Arc<VaultTier>,
    root: PathBuf,
    vault: Arc<Vault>,
}

impl DiskObserver {
    pub fn new(tier: Arc<VaultTier>, root: PathBuf, vault: Arc<Vault>) -> Self {
        Self { tier, root, vault }
    }
}

impl ApplyObserver for DiskObserver {
    fn name(&self) -> &str {
        "sync-disk"
    }

    fn records_applied(&self, batch: &[AppliedRecord]) {
        let applied = batch
            .iter()
            .filter(|record| record.outcome != AppliedOutcome::Skipped);
        let mut locks = false;
        for record in applied {
            if FILE_TYPES.contains(&record.item_type.as_str()) {
                self.tier.schedule_pulled(&record.item_id);
            }
            locks |= record.item_type == LOCK_TYPE;
        }
        if locks && let Err(error) = Locks::new(&self.root, &self.vault).reconcile() {
            tracing::warn!(
                scope = SCOPE,
                "the locked files were not brought in line after a pulled lock: {error}"
            );
        }
    }

    fn bodies_applied(&self, doc_ids: &[String]) {
        for doc_id in doc_ids {
            self.tier.schedule(doc_id);
        }
    }

    fn bodies_settled(&self) {
        let owed = match self.vault.note_files().owed_file_bodies() {
            Ok(owed) => owed,
            Err(error) => {
                tracing::error!(scope = SCOPE, "the owed files were not listed: {error}");
                return;
            }
        };
        for note_id in owed {
            self.tier.take_owed_file(&self.vault, &note_id);
        }
    }
}
