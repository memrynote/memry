//! The sync events besides the status that the supervisor tells the shell, each from the source
//! Electron's engine emits it at. The shell maps each one to its typed event.

use std::sync::Arc;

use memry_core::sync::driver::{
    AppliedOutcome, AppliedRecord, ApplyObserver, CorruptItem, SecurityWarning,
};
use memry_core::sync::policy::ServerClock;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncEvent {
    /// The records one committed page changed in this vault, told once per page, each record
    /// once with its last operation. A skipped record changed nothing and is not told
    /// (`pull-coordinator.ts:964-969`), and notes and journals are not told here.
    Pulled(Vec<PulledItem>),
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
}

/// One record a page applied.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PulledItem {
    pub item_type: String,
    pub item_id: String,
    pub operation: ItemOperation,
}

/// What a pulled record did to the local row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ItemOperation {
    Create,
    Update,
    Delete,
}

/// Notes and journals reach the renderer from the vault tier (`shell/note_events.rs`,
/// `journal_events.rs`), which writes their files; the sync feed does not tell them.
const DOCUMENT_TYPES: [&str; 2] = ["note", "journal"];

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
        let mut items: Vec<PulledItem> = Vec::new();
        for record in batch {
            let operation = match record.outcome {
                AppliedOutcome::Created => ItemOperation::Create,
                AppliedOutcome::Updated | AppliedOutcome::Merged => ItemOperation::Update,
                AppliedOutcome::Deleted => ItemOperation::Delete,
                AppliedOutcome::Skipped => continue,
            };
            if DOCUMENT_TYPES.contains(&record.item_type.as_str()) {
                continue;
            }
            match items
                .iter_mut()
                .find(|item| item.item_type == record.item_type && item.item_id == record.item_id)
            {
                Some(item) => item.operation = operation,
                None => items.push(PulledItem {
                    item_type: record.item_type.clone(),
                    item_id: record.item_id.clone(),
                    operation,
                }),
            }
        }
        if !items.is_empty() {
            (self.0)(&SyncEvent::Pulled(items));
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
