//! The driver's first-sync progress in the shape desktop's renderer already
//! renders: `InitialSyncProgressEvent` (`packages/contracts/src/ipc-events.ts`).
//!
//! The first sync's refs, metadata and bodies passes all report `notes`, the
//! pack bootstrap reports `packs`, the outbox the catch-up passes will push
//! once their seeds ran reports `tasks` (Electron's `full-sync-runner.ts`), and
//! the end reports `complete`. `manifest` belongs to the manifest check, which
//! is not the driver's.

use std::sync::{Arc, Mutex, PoisonError};

use crate::api::errors::StorageError;
use crate::storage::Db;
use crate::sync::engine::PassSeed;
use crate::sync::first_sync::{FirstSyncPhase, FirstSyncProgress, ProgressSink};
use crate::sync::outbox;
use crate::sync::pack_bootstrap::PackBootstrapReport;

/// `InitialSyncPhase`, minus `manifest` and `attachments`, which other owners
/// report.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InitialSyncPhase {
    Packs,
    Notes,
    Tasks,
    Complete,
}

impl InitialSyncPhase {
    /// The contract's string for this phase.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Packs => "packs",
            Self::Notes => "notes",
            Self::Tasks => "tasks",
            Self::Complete => "complete",
        }
    }
}

/// One `InitialSyncProgressEvent`. `processed_items` is never above
/// `total_items`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InitialSyncProgress {
    pub phase: InitialSyncPhase,
    pub processed_items: u64,
    pub total_items: u64,
}

/// Where the driver's progress goes. Synchronous, like [`ProgressSink`]: it
/// is called from inside the pass it reports.
pub trait InitialSyncSink: Send + Sync {
    fn progress(&self, progress: InitialSyncProgress);
}

/// A sink that drops everything.
pub struct SilentInitialSync;

impl InitialSyncSink for SilentInitialSync {
    fn progress(&self, _progress: InitialSyncProgress) {}
}

/// Maps the first sync's passes onto the contract's phases.
pub(super) struct Phases(pub(super) Arc<dyn InitialSyncSink>);

impl Phases {
    pub(super) fn emit(&self, phase: InitialSyncPhase, processed: u64, total: u64) {
        self.0.progress(InitialSyncProgress {
            phase,
            processed_items: processed.min(total),
            total_items: total,
        });
    }
}

impl ProgressSink for Phases {
    fn progress(&self, progress: FirstSyncProgress) {
        match progress.phase {
            FirstSyncPhase::Refs | FirstSyncPhase::Metadata | FirstSyncPhase::Bodies => {
                self.emit(InitialSyncPhase::Notes, progress.completed, progress.total);
            }
            // The catch-up passes still run; the driver reports `complete`.
            FirstSyncPhase::Done => {}
        }
    }

    fn packs(&self, report: Option<&PackBootstrapReport>) {
        // Core counts pack entries only when the run ends, so the start is
        // indeterminate (0 of 0) and the end is whole.
        let done = report.map_or(0, |report| {
            (report.entries_applied + report.entries_skipped + report.entries_failed) as u64
        });
        self.emit(InitialSyncPhase::Packs, done, done);
    }
}

/// Reports `tasks` with the outbox the pass will push, counted after every
/// other seed ran, as Electron counts after `runInitialSeed`
/// (`full-sync-runner.ts:424-451`). The driver registers it last; only its
/// first sync arms it, and the first pass that seeds reports once.
pub(super) struct TasksPhase {
    db: Db,
    armed: Mutex<Option<Arc<Phases>>>,
}

impl TasksPhase {
    pub(super) fn new(db: Db) -> Self {
        Self {
            db,
            armed: Mutex::default(),
        }
    }

    /// Arms the next seeding pass to report to `phases`, or disarms.
    pub(super) fn arm(&self, phases: Option<Arc<Phases>>) {
        *self.armed.lock().unwrap_or_else(PoisonError::into_inner) = phases;
    }
}

#[async_trait::async_trait]
impl PassSeed for TasksPhase {
    async fn seed(&self) -> Result<(), StorageError> {
        let armed = self
            .armed
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        let Some(phases) = armed else {
            return Ok(());
        };
        let now = crate::sync::pull::now_ms();
        let pending = self.db.call(move |conn| outbox::pending(conn, now)).await?;
        if pending > 0 {
            phases.emit(InitialSyncPhase::Tasks, 0, pending as u64);
        }
        Ok(())
    }
}
