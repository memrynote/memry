//! Handing a downloaded update to the installer: Restart to install, and install on a normal
//! quit (`quitAndInstall`, `performQuitAndInstall` and the `will-quit` apply of `updater.ts`).
//! The shutdown sequence calls these through its `UpdateApplyHook`; the shell exits the process.

use std::sync::atomic::Ordering;

use super::UpdaterService;
use crate::telemetry::time::now_ms;
use crate::updater::severity::UpdaterErrorPhase;
use crate::updater::state::UpdaterStatus;
use crate::updater::{guard, marker};

/// `quit_and_install` without a downloaded update.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
#[error("No downloaded update is ready to install")]
pub struct NotReady;

impl UpdaterService {
    /// Restart to install: the state turns `installing` before anything tears down, so the
    /// renderer shows the Installing screen at once. The caller then quits; the shutdown
    /// sequence ends in [`Self::apply_and_restart`].
    pub fn request_install(&self) -> Result<(), NotReady> {
        if self.state().status != UpdaterStatus::Downloaded {
            return Err(NotReady);
        }
        tracing::info!(
            scope = "Updater",
            "quitting to install update {:?}",
            self.state().available_version
        );
        self.install_requested.store(true, Ordering::SeqCst);
        self.core.on_installing();
        Ok(())
    }

    pub fn install_requested(&self) -> bool {
        self.install_requested.load(Ordering::SeqCst)
    }

    /// The OS is ending the session. Windows kills an installer started at that moment after it
    /// removed the old install (#1851), so the downloaded update waits for the next quit or the
    /// Restart prompt. An explicit Restart is the user's action and still installs.
    pub fn disable_install_on_quit(&self) {
        if !self.install_on_quit_disabled.swap(true, Ordering::SeqCst) {
            tracing::warn!(
                scope = "Updater",
                "OS session ending - skipping install-on-quit so a killed installer cannot remove the existing install"
            );
        }
    }

    /// The OS cancelled that session end.
    pub fn enable_install_on_quit(&self) {
        if self.install_on_quit_disabled.swap(false, Ordering::SeqCst) {
            tracing::info!(
                scope = "Updater",
                "session end cancelled - install-on-quit is back on"
            );
        }
    }

    /// The last evidence before the installer runs: telemetry is already disposed, so the next
    /// launch reads this marker to learn whether the install applied.
    fn write_markers(&self) {
        let Some(backend) = &self.backend else {
            return;
        };
        let state = self.state();
        marker::write_started(
            &self.data_dir,
            self.core.raw_version(),
            state.available_version.as_deref(),
            Some(backend.installer()),
            now_ms(),
        );
        if cfg!(target_os = "macos") {
            guard::write(
                &self.data_dir,
                self.core.raw_version(),
                i64::try_from(now_ms()).unwrap_or(i64::MAX),
            );
        }
    }

    /// Starts the installer with a relaunch. Once per process: the shutdown backstop may call it
    /// a second time. Returns whether this call handed off.
    pub fn apply_and_restart(&self) -> bool {
        let Some(backend) = self.backend.clone() else {
            return false;
        };
        if self.handed_off.swap(true, Ordering::SeqCst) {
            return false;
        }
        self.write_markers();
        match backend.apply(true, true) {
            Ok(()) => true,
            Err(error) => {
                // The state reads `installing`, so this counts toward the install streak.
                self.fail(error);
                false
            }
        }
    }

    /// The process is exiting normally with an update downloaded: install it without a
    /// relaunch, unless the user asked for Restart (already handed off), the session is ending,
    /// or it was handed off before.
    pub fn apply_on_quit(&self) {
        let Some(backend) = self.backend.clone() else {
            return;
        };
        if self.state().status != UpdaterStatus::Downloaded
            || self.install_requested()
            || self.install_on_quit_disabled.load(Ordering::SeqCst)
            || self.handed_off.swap(true, Ordering::SeqCst)
        {
            return;
        }
        self.write_markers();
        if let Err(error) = backend.apply(true, false) {
            // Telemetry is gone at this point; the marker reports the miss next launch.
            tracing::warn!(
                scope = "Updater",
                fields = %crate::updater::severity::describe_error(&error, UpdaterErrorPhase::Install),
                "install on quit failed"
            );
        }
    }
}
