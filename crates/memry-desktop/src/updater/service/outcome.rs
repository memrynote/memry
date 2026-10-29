//! How the previous run's hand-off to the installer ended (`detectFailedUpdateInstall` of
//! `apps/desktop/src/main/telemetry/update-install-marker.ts`). The installer runs after that
//! run's telemetry was disposed, so its marker is the only evidence, and this launch reports it.

use std::path::Path;

use super::UpdaterService;
use crate::shell::install_layout::{self, WindowsInstallLayout};
use crate::telemetry::events::{Metrics, TelemetryEvent};
use crate::telemetry::service::Service as Telemetry;
use crate::telemetry::time::now_ms;
use crate::updater::marker::{self, DetectedInstall, UpdateInstallOutcome};

/// Which installer laid down the running app. Read only for a hand-off marker.
fn current_layout() -> WindowsInstallLayout {
    let exe = std::env::current_exe().unwrap_or_default();
    install_layout::detect(&exe.to_string_lossy(), |path| Path::new(path).exists())
}

impl UpdaterService {
    /// Consumes the markers the previous run left: this app's own, and the one the last Electron
    /// build wrote into its profile before it handed over to this one. Each is read once,
    /// whatever its verdict.
    pub(super) fn report_previous_installs(&self, electron_profile: Option<&Path>) {
        let build = self.build();
        for dir in std::iter::once(self.data_dir.as_path()).chain(electron_profile) {
            if let Some(detected) = marker::detect(dir, &build, current_layout) {
                self.report_install(&detected);
            }
        }
    }

    pub(super) fn report_install(&self, detected: &DetectedInstall) {
        let attempt = &detected.attempt;
        let from = attempt.from_version.as_str();
        let to = attempt.to_version.as_deref().unwrap_or("");
        let installer = attempt.installer.map_or("updater", |i| i.as_str());
        match detected.outcome {
            UpdateInstallOutcome::Applied => tracing::info!(
                scope = "UpdateInstallMarker",
                "the update from {from} applied (installer {installer})"
            ),
            UpdateInstallOutcome::HandoffApplied => {
                tracing::info!(
                    scope = "UpdateInstallMarker",
                    "NSIS install migrated to Velopack (from {from} to {to})"
                );
                let mut event = Telemetry::event("app_update_installed", "updater", "migrated");
                event.source = Some("velopack-handoff".to_owned());
                event.result = Some("success".to_owned());
                event.dimensions = Some([("from_version".to_owned(), from.to_owned())].into());
                self.track(event);
            }
            UpdateInstallOutcome::HandoffFellBack => {
                // The update arrived (NSIS fallback or a manual install); the move to Velopack did
                // not.
                tracing::warn!(
                    scope = "UpdateInstallMarker",
                    "Velopack hand-off did not apply; the update installed through NSIS instead (from {from} to {to})"
                );
                let mut event =
                    install_error("velopack-handoff", "INSTALLER_HANDOFF_DID_NOT_APPLY");
                event.dimensions = Some([("prior_app_version".to_owned(), from.to_owned())].into());
                self.track(event);
            }
            UpdateInstallOutcome::DidNotApply => {
                tracing::error!(
                    scope = "UpdateInstallMarker",
                    "update install did not apply; still running the build that started it (from {from} to {to}, installer {installer})"
                );
                // `source` is the installer; the code stays one, so error tracking keeps one issue.
                let mut event = install_error(installer, "UPDATE_INSTALL_DID_NOT_APPLY");
                event.metrics = attempt.duration_ms(now_ms()).map(|ms| Metrics {
                    duration_ms: Some(ms as f64),
                    ..Metrics::default()
                });
                let mut dimensions = vec![("prior_app_version".to_owned(), from.to_owned())];
                if !to.is_empty() {
                    dimensions.push(("target_app_version".to_owned(), to.to_owned()));
                }
                event.dimensions = Some(dimensions.into_iter().collect());
                self.track(event);
                // Telemetry alone leaves the user on the same prompt and the same old build: the
                // renderer offers the manual installer instead.
                self.core.note_install_failed(attempt.to_version.clone());
            }
        }
    }

    fn track(&self, event: TelemetryEvent) {
        if let Some(telemetry) = &self.telemetry {
            telemetry.track_main_event(event);
        }
    }
}

/// `app_error_seen` for an install, as Electron reports it.
fn install_error(source: &str, code: &str) -> TelemetryEvent {
    let mut event = Telemetry::event("app_error_seen", "app", "install");
    event.object_type = Some("exception".to_owned());
    event.source = Some(source.to_owned());
    event.result = Some("failed".to_owned());
    event.error_code = Some(code.to_owned());
    event
}
