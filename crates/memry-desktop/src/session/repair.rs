//! Repair of a damaged `data.db`, and the check that no stuck thread still holds a vault.

use std::path::Path;
use std::time::{Duration, Instant};

use memry_core::api::errors::StorageError;
use memry_core::storage::recovery::RecoveryReport;

use super::{Session, SessionError, canonical, lock, open};
use crate::registry::create::CreateError;

#[derive(Debug)]
pub enum RepairOutcome {
    /// The database opened and passed its integrity check: nothing was moved.
    NotCorrupt,
    Rebuilt(RecoveryReport),
}

impl Session {
    /// The user agreed to repair a damaged `data.db` of the vault at `vault_path`. Under the
    /// lifecycle queue: refuses while that vault is open or a stuck thread may hold it,
    /// re-runs the verified open (the file may be fine now, and then nothing moves), and only
    /// if it still reports damage quarantines and rebuilds. The caller reopens afterwards.
    pub fn repair(&self, vault_path: &Path) -> Result<RepairOutcome, SessionError> {
        let _queue = lock(&self.inner.lifecycle);
        let open_here = self
            .current()
            .is_some_and(|open| canonical(&open.path) == canonical(vault_path));
        if open_here {
            return Err(SessionError::Held(vault_path.display().to_string()));
        }
        self.ensure_not_held(vault_path)?;
        let data_db = open::core_dir(vault_path).join("data.db");
        let verified = memry_core::storage::OpenOptions {
            verify_integrity: true,
        };
        match memry_core::storage::open_data_with(&data_db, verified) {
            Ok(db) => {
                drop(db);
                Ok(RepairOutcome::NotCorrupt)
            }
            Err(StorageError::Corrupt { .. }) => {
                let report = memry_core::storage::recovery::quarantine_and_rebuild(&data_db)?;
                if let Some(problems) = report.problems() {
                    tracing::warn!(quarantined = %report.quarantined.display(), %problems, "recovery was partial");
                } else {
                    tracing::info!(quarantined = %report.quarantined.display(), "data.db recovered");
                }
                Ok(RepairOutcome::Rebuilt(report))
            }
            Err(other) => Err(other.into()),
        }
    }

    /// Refuses while a thread that outlived an earlier close of this vault still holds its
    /// databases. Retries for up to one hook deadline first: the thread is usually on its way
    /// out, and an immediate error would turn a slow close into a failed switch.
    pub(super) fn ensure_not_held(&self, path: &Path) -> Result<(), SessionError> {
        let key = canonical(path);
        let end = Instant::now() + self.inner.hook_deadline;
        loop {
            let mut held = lock(&self.inner.held);
            held.retain(|_, (vault, search)| vault.strong_count() > 0 || search.strong_count() > 0);
            if !held.contains_key(&key) {
                return Ok(());
            }
            drop(held);
            if Instant::now() >= end {
                return Err(SessionError::Held(path.display().to_string()));
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

/// [`Session::create`] fails either creating the folder or opening it.
#[derive(Debug, thiserror::Error)]
pub enum CreateOrOpenError {
    #[error(transparent)]
    Create(#[from] CreateError),
    #[error(transparent)]
    Open(#[from] SessionError),
}
