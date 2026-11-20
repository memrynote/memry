//! The sync events besides the status that the supervisor tells the shell, each from the source
//! Electron's engine emits it at. The shell maps each one to its typed event.

use std::sync::Arc;

use memry_core::sync::driver::{
    AppliedOutcome, AppliedRecord, ApplyObserver, CorruptItem, SecurityWarning,
};
use memry_core::sync::policy::ServerClock;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncEvent {
    /// A pulled record changed this vault, told after its page committed. A skipped record
    /// changed nothing and is not told (`pull-coordinator.ts:964-969`).
    Pulled {
        item_type: String,
        item_id: String,
        operation: ItemOperation,
    },
    /// A pass pushed rows and left the outbox empty (`push-coordinator.ts:518-535`).
    QueueCleared { item_count: u32, duration_ms: i64 },
    /// The local clock is off from the server's by more than five minutes and sync paused, in
    /// whole seconds (`sync-state-manager.ts:285-300`).
    ClockSkew {
        local_s: i64,
        server_s: i64,
        skew_s: i64,
    },
    /// A pulled record's signature did not verify and its quarantine counted it
    /// (`quarantine-manager.ts:64`).
    SecurityWarning(SecurityWarning),
    /// A pulled record did not decode and its row is held corrupt, on the feed or on the hourly
    /// refetch (`pull-breaker.ts:52`, `item-recovery.ts:177`).
    Corrupt {
        item_type: String,
        item_id: String,
        reason: String,
    },
    /// A row held corrupt was refetched and applied (`item-recovery.ts:78`).
    Recovered { item_type: String, item_id: String },
    /// A download of the note's attachment landed and is recorded, so an open note resolves
    /// its attachment again (`sync-attachment-handlers.ts:703`).
    AttachmentMaterialized { note_id: String },
    /// An attachment of the note failed to download (`disk_path` is where it was going,
    /// `sync-attachment-handlers.ts:743`) or will not upload (`disk_path` is the file: dropped,
    /// or stuck after its last attempt). Electron sends both as `ATTACHMENT_UPLOAD_FAILED`.
    AttachmentFailed {
        note_id: String,
        disk_path: String,
        error: String,
    },
}

/// What a pulled record did to the local row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ItemOperation {
    Create,
    Update,
    Delete,
}

pub type OnSyncEvent = Arc<dyn Fn(&SyncEvent) + Send + Sync>;

impl SyncEvent {
    pub(super) fn clock_skew(clock: ServerClock) -> Self {
        let local_s = clock.local_ms.div_euclid(1000);
        let server_s = clock.server_ms.div_euclid(1000);
        Self::ClockSkew {
            local_s,
            server_s,
            skew_s: (local_s - server_s).abs(),
        }
    }
}

/// Tells the shell what each committed page applied, each row it held corrupt or recovered,
/// and each quarantine it counted.
pub(super) struct EventObserver(pub(super) OnSyncEvent);

impl ApplyObserver for EventObserver {
    fn name(&self) -> &str {
        "sync-events"
    }

    fn records_applied(&self, batch: &[AppliedRecord]) {
        for record in batch {
            let operation = match record.outcome {
                AppliedOutcome::Created => ItemOperation::Create,
                AppliedOutcome::Updated | AppliedOutcome::Merged => ItemOperation::Update,
                AppliedOutcome::Deleted => ItemOperation::Delete,
                AppliedOutcome::Skipped => continue,
            };
            (self.0)(&SyncEvent::Pulled {
                item_type: record.item_type.clone(),
                item_id: record.item_id.clone(),
                operation,
            });
        }
    }

    fn security_warning(&self, warning: &SecurityWarning) {
        (self.0)(&SyncEvent::SecurityWarning(warning.clone()));
    }

    fn item_corrupt(&self, item: &CorruptItem) {
        (self.0)(&SyncEvent::Corrupt {
            item_type: item.item_type.clone(),
            item_id: item.item_id.clone(),
            reason: item.reason.clone(),
        });
    }

    fn item_recovered(&self, record: &AppliedRecord) {
        (self.0)(&SyncEvent::Recovered {
            item_type: record.item_type.clone(),
            item_id: record.item_id.clone(),
        });
    }
}
