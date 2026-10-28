//! The one update state and its transitions (`apps/desktop/src/main/updater.ts`, the `host`
//! callbacks). Every transition an update backend can cause goes through [`UpdaterCore`], so
//! the renderer never learns which backend is installed. The serialized shape is the IPC
//! contract `packages/contracts/src/ipc-updater.ts` `AppUpdateState`.

use std::sync::{Mutex, PoisonError};

use serde::{Deserialize, Serialize};
use tokio::sync::watch;

use super::check_health::UpdaterCheckHealth;
use super::severity::UpdaterErrorPhase;
use super::version::format_app_version_for_display;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum UpdaterStatus {
    Unavailable,
    Idle,
    Checking,
    Available,
    Downloading,
    Downloaded,
    Installing,
    UpToDate,
    Error,
}

/// The previous session handed off an install that never applied.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct InstallFailed {
    /// The update that failed, or `None` when the marker did not record one.
    pub version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateState {
    /// Display version (`vYYYY-MM-DD[.N]`).
    pub current_version: String,
    pub status: UpdaterStatus,
    pub update_supported: bool,
    pub available_version: Option<String>,
    pub release_name: Option<String>,
    pub release_date: Option<String>,
    /// Plain text without the developer changelog, for the prompt.
    pub release_notes: Option<String>,
    /// The whole feed HTML, for the release notes tab.
    pub release_notes_html: Option<String>,
    pub download_progress_percent: Option<u8>,
    /// Epoch milliseconds.
    pub last_checked_at: Option<i64>,
    pub error: Option<String>,
    pub auto_download_enabled: bool,
    pub auto_check_enabled: bool,
    pub install_failed: Option<InstallFailed>,
}

/// A release a check found. `version` is raw; the state shows its display form.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct AvailableUpdate {
    pub version: String,
    pub release_name: Option<String>,
    pub release_date: Option<String>,
    pub release_notes: Option<String>,
    pub release_notes_html: Option<String>,
}

/// Owns [`AppUpdateState`]. Readers subscribe to the `watch` channel; every patch publishes.
pub struct UpdaterCore {
    raw_version: String,
    supported: bool,
    state: watch::Sender<AppUpdateState>,
    check_health: Mutex<UpdaterCheckHealth>,
}

impl UpdaterCore {
    /// `raw_version` is the running build's `YYYY.MDD.N`. Prefs default to auto check on and
    /// auto download off until the service reads them.
    pub fn new(raw_version: &str, supported: bool, now_ms: u64) -> Self {
        let state = AppUpdateState {
            current_version: format_app_version_for_display(raw_version),
            status: if supported {
                UpdaterStatus::Idle
            } else {
                UpdaterStatus::Unavailable
            },
            update_supported: supported,
            available_version: None,
            release_name: None,
            release_date: None,
            release_notes: None,
            release_notes_html: None,
            download_progress_percent: None,
            last_checked_at: None,
            error: None,
            auto_download_enabled: false,
            auto_check_enabled: true,
            install_failed: None,
        };
        Self {
            raw_version: raw_version.to_owned(),
            supported,
            state: watch::Sender::new(state),
            check_health: Mutex::new(UpdaterCheckHealth::new(now_ms)),
        }
    }

    pub fn raw_version(&self) -> &str {
        &self.raw_version
    }

    pub fn display_version(&self) -> String {
        format_app_version_for_display(&self.raw_version)
    }

    pub fn state(&self) -> AppUpdateState {
        self.state.borrow().clone()
    }

    pub fn subscribe(&self) -> watch::Receiver<AppUpdateState> {
        self.state.subscribe()
    }

    /// Applies `change`, then restores the two fields no transition may set, and publishes only
    /// when the state changed: a progress tick that rounds to the shown percent reaches no window.
    fn patch(&self, change: impl FnOnce(&mut AppUpdateState)) {
        let supported = self.supported;
        let current_version = self.display_version();
        self.state.send_if_modified(|state| {
            let before = state.clone();
            change(state);
            state.current_version = current_version;
            state.update_supported = supported;
            *state != before
        });
    }

    /// Applies a check or download result unless Restart to install already showed the
    /// Installing screen. The status is read inside the publish, so a result that lands after
    /// the install began never replaces it. Returns whether `change` ran.
    fn advance(&self, change: impl FnOnce(&mut AppUpdateState)) -> bool {
        let mut applied = false;
        self.patch(|state| {
            if state.status != UpdaterStatus::Installing {
                change(state);
                applied = true;
            }
        });
        applied
    }

    /// The persisted auto-download preference, as the service read or changed it.
    pub fn set_auto_download_enabled(&self, enabled: bool) {
        self.patch(|state| state.auto_download_enabled = enabled);
    }

    /// The persisted auto-check preference, as the service read or changed it.
    pub fn set_auto_check_enabled(&self, enabled: bool) {
        self.patch(|state| state.auto_check_enabled = enabled);
    }

    fn clear_available(state: &mut AppUpdateState) {
        state.available_version = None;
        state.release_name = None;
        state.release_date = None;
        state.release_notes = None;
        state.release_notes_html = None;
        state.download_progress_percent = None;
        state.error = None;
    }

    fn show(state: &mut AppUpdateState, update: &AvailableUpdate) {
        state.available_version = Some(format_app_version_for_display(&update.version));
        state.release_name = update.release_name.clone();
        state.release_date = update.release_date.clone();
        state.release_notes = update.release_notes.clone();
        state.release_notes_html = update.release_notes_html.clone();
        state.error = None;
    }

    fn check_health(&self) -> std::sync::MutexGuard<'_, UpdaterCheckHealth> {
        self.check_health
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    pub fn reset_check_health(&self, now_ms: u64) {
        self.check_health().reset(now_ms);
    }

    /// A check reached the feed while the state stays as it is (an update already downloaded).
    pub fn note_check_success(&self, now_ms: u64) {
        self.check_health().record_check_success(now_ms);
    }

    /// Counts a failed check: the streak and whether it just became stuck.
    pub fn record_check_failure(&self, now_ms: u64) -> (u32, bool) {
        self.check_health().record_check_failure(now_ms)
    }

    pub fn on_checking(&self, now_ms: u64) {
        tracing::info!(scope = "Updater", "checking for updates");
        self.advance(|state| {
            state.status = UpdaterStatus::Checking;
            state.error = None;
            state.last_checked_at = i64::try_from(now_ms).ok();
            state.download_progress_percent = None;
        });
    }

    /// False when the user skipped this version (its display form equals `skipped`): the state
    /// is then up to date and the backend must not download it. False as well once Restart to
    /// install began, which leaves the state alone. A manual check clears the skip
    /// before it runs.
    pub fn on_update_available(
        &self,
        update: &AvailableUpdate,
        skipped: Option<&str>,
        now_ms: u64,
    ) -> bool {
        self.check_health().record_check_success(now_ms);
        if skipped == Some(format_app_version_for_display(&update.version).as_str()) {
            tracing::info!(
                scope = "Updater",
                "update {} available but skipped by user",
                update.version
            );
            self.advance(|state| {
                state.status = UpdaterStatus::UpToDate;
                Self::clear_available(state);
            });
            return false;
        }
        tracing::info!(scope = "Updater", "update {} available", update.version);
        self.advance(|state| {
            state.status = UpdaterStatus::Available;
            Self::show(state, update);
            state.download_progress_percent = None;
        })
    }

    pub fn on_up_to_date(&self, now_ms: u64) {
        self.check_health().record_check_success(now_ms);
        tracing::info!(scope = "Updater", "no update available");
        self.advance(|state| {
            state.status = UpdaterStatus::UpToDate;
            Self::clear_available(state);
        });
    }

    /// The user skipped the offered version: up to date, offer cleared.
    pub fn on_version_skipped(&self) {
        self.advance(|state| {
            state.status = UpdaterStatus::UpToDate;
            Self::clear_available(state);
        });
    }

    /// A download starts: progress keeps what it had, from zero.
    pub fn on_download_started(&self) {
        tracing::info!(scope = "Updater", "starting update download");
        self.advance(|state| {
            state.status = UpdaterStatus::Downloading;
            state.error = None;
            state.download_progress_percent = Some(state.download_progress_percent.unwrap_or(0));
        });
    }

    /// `percent` is rounded and clamped to 0..=100; a non-number is 0.
    pub fn on_download_progress(&self, percent: f64) {
        let rounded = if percent.is_finite() {
            // `Math.round`: halves go up.
            (percent + 0.5).floor().clamp(0.0, 100.0) as u8
        } else {
            0
        };
        self.advance(|state| {
            state.status = UpdaterStatus::Downloading;
            state.download_progress_percent = Some(rounded);
        });
    }

    pub fn on_downloaded(&self, update: &AvailableUpdate) {
        tracing::info!(scope = "Updater", "update {} downloaded", update.version);
        self.advance(|state| {
            state.status = UpdaterStatus::Downloaded;
            Self::show(state, update);
            state.download_progress_percent = Some(100);
        });
    }

    /// The failure as the user sees it. Logging, telemetry and the install streak are the
    /// service's, which reads [`Self::current_phase`] before calling this.
    pub fn on_error(&self, message: String) {
        self.patch(|state| {
            state.status = UpdaterStatus::Error;
            state.error = Some(message);
        });
    }

    /// Restart to install: the renderer shows the Installing screen before teardown starts.
    pub fn on_installing(&self) {
        self.patch(|state| state.status = UpdaterStatus::Installing);
    }

    /// The phase a failure arriving now belongs to, from the status it interrupts.
    pub fn current_phase(&self) -> UpdaterErrorPhase {
        match self.state.borrow().status {
            UpdaterStatus::Checking => UpdaterErrorPhase::Check,
            UpdaterStatus::Downloading => UpdaterErrorPhase::Download,
            UpdaterStatus::Downloaded => UpdaterErrorPhase::Downloaded,
            UpdaterStatus::Installing => UpdaterErrorPhase::Install,
            _ => UpdaterErrorPhase::Idle,
        }
    }

    /// Surfaces a previous session's failed install, so the renderer offers the manual
    /// installer instead of the same Restart prompt.
    pub fn note_install_failed(&self, version: Option<String>) {
        tracing::warn!(
            scope = "Updater",
            "previous update install did not apply: {version:?}"
        );
        self.patch(|state| state.install_failed = Some(InstallFailed { version }));
    }
}

#[cfg(test)]
mod tests;
