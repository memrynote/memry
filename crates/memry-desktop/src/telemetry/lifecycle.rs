//! The events of the app's own life: start, update, crash, launch phases, heartbeat, and a
//! changed setting (`runtime.ts`, `crash-marker.ts`, `diagnostics.ts`, `settings-handlers.ts`).

use super::crash::CrashReport;
use super::events::Metrics;
use super::service::Service;
use crate::redact::is_safe_dimension_value;

/// `app_started`, once per launch.
pub fn app_started(service: &Service) {
    let mut event = Service::event("app_started", "app", "started");
    event.result = Some("success".to_owned());
    service.track(event);
}

/// `app_update_installed` when the version differs from the last launch's, then stores the
/// current version. Only an enabled install reports; the stored version moves either way.
pub fn version_check(service: &Service, current: &str) {
    let last = service.config().last_run_version();
    if service.enabled()
        && let Some(last) = last.as_deref().filter(|last| *last != current)
    {
        let mut event = Service::event("app_update_installed", "updater", "installed");
        event.result = Some("success".to_owned());
        event.dimensions = Some([("from_version".to_owned(), last.to_owned())].into());
        service.track(event);
    }
    if last.as_deref() != Some(current) {
        service.config().set_last_run_version(current);
    }
}

/// `app_crashed` for the previous session's unclean shutdown.
pub fn crashed(service: &Service, report: &CrashReport) {
    let mut event = Service::event("app_crashed", "app", "unclean_shutdown");
    event.source = Some("main_process".to_owned());
    event.result = Some("failed".to_owned());
    event.error_code = Some(report.error_code.clone());
    event.error = Some(super::events::ErrorDetail {
        message: Some(report.message.clone()),
        ..Default::default()
    });
    event.metrics = report.duration_ms.map(|ms| Metrics {
        duration_ms: Some(ms as f64),
        ..Metrics::default()
    });
    event.dimensions = report
        .prior_app_version
        .as_ref()
        .map(|version| [("prior_app_version".to_owned(), version.clone())].into());
    service.track(event);
}

/// `app_launch_phase_completed` for one launch-timeline mark.
pub fn launch_phase(service: &Service, phase: &str, elapsed_ms: u64) {
    let mut event = Service::event(
        "app_launch_phase_completed",
        "app",
        &super::events::to_safe_token(phase, "phase"),
    );
    event.source = Some("main_process".to_owned());
    event.result = Some("success".to_owned());
    event.metrics = Some(Metrics {
        duration_ms: Some(elapsed_ms as f64),
        ..Metrics::default()
    });
    service.track(event);
}

pub const HEARTBEAT_SECONDS: u64 = 5 * 60;

pub fn heartbeat(service: &Service) {
    let mut event = Service::event("app_active_heartbeat", "app", "heartbeat");
    event.metrics = Some(Metrics {
        active_seconds: Some(HEARTBEAT_SECONDS as f64),
        ..Metrics::default()
    });
    service.track(event);
}

pub fn backgrounded(service: &Service) {
    service.track(Service::event("app_backgrounded", "app", "backgrounded"));
}

/// `setting_changed` with the setting name only, never a value, and only when the name passes
/// the dimension gate.
pub fn setting_changed(service: &Service, setting: &str) {
    if !is_safe_dimension_value(setting) {
        return;
    }
    let mut event = Service::event("setting_changed", "settings", "changed");
    event.dimensions = Some([("setting".to_owned(), setting.to_owned())].into());
    service.track(event);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::telemetry::service::{Context, Sender};

    fn service(dir: &tempfile::TempDir, enabled: bool) -> Service {
        let context = Context {
            install_id: "i".into(),
            session_id: "s".into(),
            app_version: "2.0.0".into(),
            build_channel: "production".into(),
            platform: "linux".into(),
            arch: "x64".into(),
            locale: "en".into(),
            timezone_offset_minutes: 0,
        };
        Service::start(
            dir.path(),
            context,
            Sender::new("http://127.0.0.1:1/x"),
            enabled,
        )
    }

    #[test]
    fn an_upgrade_reports_once_with_the_previous_version_and_stores_the_new_one() {
        let dir = tempfile::tempdir().expect("tmp");
        let s = service(&dir, true);
        version_check(&s, "1.0.0");
        assert!(s.queued().is_empty(), "a first launch is not an update");
        version_check(&s, "2.0.0");
        let queued = s.queued();
        assert_eq!(queued.len(), 1);
        assert_eq!(queued[0].name, "app_update_installed");
        assert_eq!(
            queued[0].dimensions.as_ref().expect("dim")["from_version"],
            "1.0.0"
        );
        version_check(&s, "2.0.0");
        assert_eq!(s.queued().len(), 1);
        assert_eq!(s.config().last_run_version().as_deref(), Some("2.0.0"));
    }

    #[test]
    fn a_disabled_install_reports_nothing_but_still_moves_the_stored_version() {
        let dir = tempfile::tempdir().expect("tmp");
        let s = service(&dir, false);
        s.config().set_last_run_version("1.0.0");
        version_check(&s, "2.0.0");
        app_started(&s);
        assert!(s.queued().is_empty());
        assert_eq!(s.config().last_run_version().as_deref(), Some("2.0.0"));
    }

    #[test]
    fn a_crash_report_becomes_an_app_crashed_event_and_a_setting_name_is_gated() {
        let dir = tempfile::tempdir().expect("tmp");
        let s = service(&dir, true);
        crashed(
            &s,
            &CrashReport {
                error_code: "UNCLEAN_SHUTDOWN".into(),
                message: "m".into(),
                duration_ms: Some(42),
                prior_app_version: Some("1.9.0".into()),
            },
        );
        launch_phase(&s, "vault_open_ready", 120);
        setting_changed(&s, "general.theme");
        setting_changed(&s, "has/slash");
        let queued = s.queued();
        assert_eq!(
            queued.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(),
            [
                "app_crashed",
                "app_launch_phase_completed",
                "setting_changed"
            ]
        );
        assert_eq!(queued[0].error_code.as_deref(), Some("UNCLEAN_SHUTDOWN"));
        assert_eq!(
            queued[0].metrics.as_ref().expect("m").duration_ms,
            Some(42.0)
        );
        assert_eq!(queued[1].action, "vault_open_ready");
    }
}
