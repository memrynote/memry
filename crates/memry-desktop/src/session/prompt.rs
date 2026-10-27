//! When the user is asked to repair a damaged `data.db`, and what happens after the answer
//! (port of `vault/data-db-recovery-prompt.ts`). The dialog itself belongs to the shell; this
//! module owns the policy so it runs against real files in tests.
//!
//! - The user is asked at most once per app session, at open or mid-session.
//! - Recovery is never silent: nothing moves before the user says Repair.
//! - Not now leaves the registry entry intact, so the next launch asks again.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::i18n;

use super::{OpenSource, RepairOutcome, Session, SessionError, VaultOpened};

/// The dialog's strings in `locale` (`system:dialog.dataDbRecovery.*`).
pub struct Text {
    pub title: String,
    pub message: String,
    pub repair: String,
    pub later: String,
}

pub fn text(locale: &str) -> Text {
    let t = |key: &str| {
        i18n::t(
            locale,
            &format!("system:dialog.dataDbRecovery.{key}"),
            &i18n::Args::new(),
        )
    };
    Text {
        title: t("title"),
        message: t("message"),
        repair: t("buttonRecover"),
        later: t("buttonLater"),
    }
}

/// The detail with the damaged database's path, where the backup will be kept.
pub fn detail(locale: &str, data_db: &Path) -> String {
    let backup = format!("{}.corrupt-<timestamp>", data_db.display());
    i18n::t(
        locale,
        "system:dialog.dataDbRecovery.detail",
        &i18n::Args::from([("path".to_owned(), i18n::Arg::from(backup.as_str()))]),
    )
}

/// Whoever shows the dialog.
pub trait Asker {
    /// `true` when the user chose Repair.
    fn confirm_repair(&self, data_db: &Path) -> bool;
}

#[derive(Default)]
pub struct RecoveryPrompt {
    offered: AtomicBool,
}

impl RecoveryPrompt {
    /// Runs `open`; when it reports a damaged database and the user was not yet asked this
    /// session, asks, repairs and opens once more. Any other outcome is returned as it came.
    pub fn open_with_offer(
        &self,
        session: &Session,
        asker: &dyn Asker,
        vault: &Path,
        open: impl Fn() -> Result<VaultOpened, SessionError>,
    ) -> Result<VaultOpened, SessionError> {
        let first = open();
        if !matches!(first, Err(SessionError::Corrupt { .. })) {
            return first;
        }
        if !self.begin_offer() || !self.repaired(session, asker, vault) {
            return first;
        }
        open()
    }

    /// A damaged database showed up while the vault was open (`SQLITE_CORRUPT` from a
    /// query). Asks once; on Repair closes the vault, repairs and opens it again. Returns
    /// whether the vault was repaired.
    pub fn offer_for_open_vault(
        &self,
        session: &Session,
        asker: &dyn Asker,
    ) -> Option<Result<VaultOpened, SessionError>> {
        let current = session.current()?;
        let path = current.path.clone();
        // Dropped before `close`: a clone keeps the old `Vault` alive and `repair` refuses.
        drop(current);
        if !self.begin_offer() {
            return None;
        }
        // Only a vault whose database really fails the verified open is offered repair; the
        // open vault itself must close first, so ask before closing.
        if !asker.confirm_repair(&super::open::core_dir(&path).join("data.db")) {
            return None;
        }
        session.close();
        Some(match session.repair(&path) {
            Ok(_) => session.open(&path, OpenSource::Select),
            Err(error) => Err(error),
        })
    }

    /// True the first time it is called in this app session.
    fn begin_offer(&self) -> bool {
        !self.offered.swap(true, Ordering::SeqCst)
    }

    fn repaired(&self, session: &Session, asker: &dyn Asker, vault: &Path) -> bool {
        let data_db = super::open::core_dir(vault).join("data.db");
        if !asker.confirm_repair(&data_db) {
            tracing::warn!(vault = %vault.display(), "the user postponed the data.db repair");
            return false;
        }
        match session.repair(vault) {
            Ok(RepairOutcome::Rebuilt(report)) => {
                tracing::info!(quarantined = %report.quarantined.display(), "data.db repaired");
                true
            }
            Ok(RepairOutcome::NotCorrupt) => true,
            Err(error) => {
                tracing::error!(%error, "data.db repair failed");
                false
            }
        }
    }
}

#[cfg(test)]
mod tests;
