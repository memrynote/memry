//! The NSIS install an Electron build left beside this app, removed and reported
//! ([`crate::updater::nsis_leftover`]).

use std::path::{Path, PathBuf};

use super::UpdaterService;
use super::outcome::install_error;
use crate::telemetry::events::Metrics;
use crate::telemetry::service::Service as Telemetry;
use crate::telemetry::time::now_ms;
use crate::updater::nsis_leftover::{self, Context, Keep, LeftoverHost, Outcome};

impl UpdaterService {
    /// One pass on a blocking thread, after [`Self::init`]. Nothing is removed while a failed
    /// install is live: the user may still need the old app.
    pub fn retire_nsis_leftover(
        &self,
        host: &dyn LeftoverHost,
        own_install: &[PathBuf],
        user_roots: &[PathBuf],
        pins_dir: Option<&Path>,
    ) {
        if self.state().install_failed.is_some() {
            tracing::info!(
                scope = "NsisLeftover",
                "an update install failed; the NSIS install stays for now"
            );
            return;
        }
        let outcome = nsis_leftover::retire(
            host,
            &Context {
                data_dir: &self.data_dir,
                own_install,
                user_roots,
                pins_dir,
                now_ms: now_ms(),
            },
        );
        match outcome {
            Outcome::None | Outcome::Waiting => {}
            Outcome::Retired { stale_pins } => {
                tracing::info!(
                    scope = "NsisLeftover",
                    "removed the NSIS install an Electron build left; {stale_pins} taskbar pins pointed into it"
                );
                let mut event = Telemetry::event("app_update_installed", "updater", "migrated");
                event.source = Some("electron-updater".to_owned());
                event.result = Some("success".to_owned());
                event.metrics = Some(Metrics {
                    item_count: Some(stale_pins as f64),
                    ..Metrics::default()
                });
                self.track(event);
            }
            Outcome::Kept {
                reason,
                first_report,
            } => {
                let token = reason.as_str();
                // Expected: a process still running from it, or an install for all users that
                // this app cannot remove without elevation.
                if matches!(reason, Keep::InUse | Keep::PerMachine) {
                    tracing::info!(scope = "NsisLeftover", "the NSIS install stays: {token}");
                } else {
                    tracing::warn!(scope = "NsisLeftover", "the NSIS install stays: {token}");
                }
                if first_report {
                    let code = if reason == Keep::PerMachine {
                        "NSIS_CLEANUP_SKIPPED"
                    } else {
                        "NSIS_CLEANUP_FAILED"
                    };
                    let mut event = install_error("electron-updater", code);
                    event.dimensions = Some([("skip_reason".to_owned(), token.to_owned())].into());
                    self.track(event);
                }
            }
        }
    }
}
