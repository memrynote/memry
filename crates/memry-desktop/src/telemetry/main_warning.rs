//! Main-process reporting: `trackMainEvent`, `trackMainLog`, `trackMainWarning` and
//! `trackMainError` of `apps/desktop/src/main/telemetry/diagnostics.ts`.

use std::sync::PoisonError;

use super::diagnostics::{Failure, error_code, error_detail};
use super::events::{ErrorDetail, Metrics, TelemetryEvent, to_safe_token};
use super::service::Service;
use crate::redact::{RedactOptions, salted_hash};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Level {
    Debug,
    Info,
    Warn,
    Error,
}

impl Level {
    fn wire(self) -> &'static str {
        match self {
            Self::Debug => "debug",
            Self::Info => "info",
            Self::Warn => "warn",
            Self::Error => "error",
        }
    }
}

impl Service {
    /// Queues a main-process event. Never panics and never blocks.
    pub fn track_main_event(&self, mut event: TelemetryEvent) {
        if event.occurred_at.is_empty() {
            event.occurred_at = super::time::iso(super::time::now_ms());
        }
        self.track(event);
    }

    /// One `app_log_recorded` event: the level is the action, the scope the source, and the
    /// log action the one dimension.
    pub fn track_main_log(
        &self,
        level: Level,
        scope: &str,
        action: &str,
        code: Option<&str>,
        error: Option<ErrorDetail>,
        metrics: Option<Metrics>,
    ) {
        let mut event = Self::event("app_log_recorded", "app", level.wire());
        event.object_type = Some("log".to_owned());
        event.source = Some(to_safe_token(scope, "main_process"));
        event.result = Some(
            if matches!(level, Level::Error | Level::Warn) {
                "failed"
            } else {
                "success"
            }
            .to_owned(),
        );
        event.dimensions = Some([("log_action".to_owned(), to_safe_token(action, "event"))].into());
        event.error_code = code.map(|code| to_safe_token(code, "LogError"));
        event.error = error;
        event.metrics = metrics;
        self.track_main_event(event);
    }

    fn redact_detail(&self, failure: &Failure, source: &str, action: &str) -> Option<ErrorDetail> {
        let hasher = |value: &str| salted_hash(&self.salt, value);
        let root = self
            .vault_root
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        let opts = RedactOptions {
            vault_root: root.as_deref(),
            hash: Some(&hasher),
        };
        error_detail(failure, None, &opts, &format!("{source}/{action}"))
    }

    /// A failure that is not an error: an expected condition is dropped, anything else ships as
    /// an `app_log_recorded` warn with the error code and redacted detail, never as
    /// `app_error_seen`.
    pub fn track_main_warning(
        &self,
        source: &str,
        action: &str,
        failure: &Failure,
        retry_count: Option<u32>,
    ) {
        if failure.expected_condition {
            return;
        }
        let metrics = retry_count.map(|count| Metrics {
            retry_count: Some(f64::from(count)),
            ..Metrics::default()
        });
        self.track_main_log(
            Level::Warn,
            source,
            action,
            Some(&error_code(failure)),
            self.redact_detail(failure, source, action),
            metrics,
        );
    }

    /// A failure that is an error: `app_error_seen`, unless it is an expected condition (dropped)
    /// or an expected warning (demoted to [`Service::track_main_warning`]).
    pub fn track_main_error(&self, source: &str, action: &str, failure: &Failure) {
        if failure.expected_condition {
            return;
        }
        if failure.is_expected_warning() {
            self.track_main_warning(source, action, failure, None);
            return;
        }
        let mut event = Self::event("app_error_seen", "app", &to_safe_token(action, "error"));
        event.object_type = Some("exception".to_owned());
        event.source = Some(to_safe_token(source, "main_process"));
        event.result = Some("failed".to_owned());
        event.error_code = Some(error_code(failure));
        event.error = self.redact_detail(failure, source, action);
        self.track_main_event(event);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::telemetry::service::{Context, Sender};

    fn service(dir: &tempfile::TempDir) -> Service {
        let context = Context {
            install_id: "i".into(),
            session_id: "s".into(),
            app_version: "1.0.0".into(),
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
            true,
        )
    }

    #[test]
    fn a_warning_ships_as_a_log_with_the_code_and_redacted_detail_and_never_as_an_error() {
        let dir = tempfile::tempdir().expect("tmp");
        let service = service(&dir);
        service.track_main_warning(
            "Updater",
            "check",
            &Failure::new(Some("EBUSY"), "locked /Users/kaan/a.md"),
            Some(2),
        );
        let queued = service.queued();
        assert_eq!(queued.len(), 1);
        let event = &queued[0];
        assert_eq!(event.name, "app_log_recorded");
        assert_eq!(
            (event.action.as_str(), event.result.as_deref()),
            ("warn", Some("failed"))
        );
        assert_eq!(event.error_code.as_deref(), Some("EBUSY"));
        assert_eq!(event.source.as_deref(), Some("Updater"));
        assert_eq!(
            event.dimensions.as_ref().expect("dim")["log_action"],
            "check"
        );
        assert_eq!(
            event.metrics.as_ref().expect("metrics").retry_count,
            Some(2.0)
        );
        assert!(
            !event
                .error
                .as_ref()
                .expect("detail")
                .message
                .as_deref()
                .expect("message")
                .contains("kaan")
        );
    }

    #[test]
    fn an_expected_condition_is_dropped_by_both_entry_points() {
        let dir = tempfile::tempdir().expect("tmp");
        let service = service(&dir);
        let cancelled = Failure {
            expected_condition: true,
            ..Failure::new(Some("CANCELLED"), "user cancelled")
        };
        service.track_main_warning("Updater", "check", &cancelled, None);
        service.track_main_error("Updater", "check", &cancelled);
        assert!(service.queued().is_empty());
    }

    #[test]
    fn an_error_that_is_an_expected_warning_is_demoted_to_the_warning_event() {
        let dir = tempfile::tempdir().expect("tmp");
        let service = service(&dir);
        service.track_main_error(
            "Sync",
            "push",
            &Failure::new(Some("ENOTFOUND"), "getaddrinfo"),
        );
        service.track_main_error(
            "Sync",
            "push",
            &Failure {
                expected_warning: true,
                ..Failure::new(None, "rate limited")
            },
        );
        service.track_main_error("Sync", "push", &Failure::new(Some("SQLITE_BUSY"), "locked"));
        let names: Vec<_> = service
            .queued()
            .iter()
            .map(|e| (e.name.clone(), e.action.clone()))
            .collect();
        assert_eq!(
            names,
            [
                ("app_log_recorded".to_owned(), "warn".to_owned()),
                ("app_log_recorded".to_owned(), "warn".to_owned()),
                ("app_error_seen".to_owned(), "push".to_owned()),
            ]
        );
    }
}
