//! A failed command as one telemetry event. The command name and the error code leave the
//! device; the message never does, because it can carry note-derived text. The
//! `FailureReporter` throttle (one report per command and code per minute) sits in front.

use std::sync::Arc;

use super::main_warning::Level;
use super::service::Service;
use crate::command_failure::{FailureDetails, FailureSink};

pub struct TelemetryFailureSink(pub Arc<Service>);

impl FailureSink for TelemetryFailureSink {
    fn report(&self, command: &str, error: FailureDetails<'_>) {
        // The log still carries the message, redacted by the log pipeline.
        tracing::warn!(
            command,
            kind = error.kind,
            code = error.code,
            "command failed: {}",
            error.message
        );
        self.0
            .track_main_log(Level::Warn, "ipc", command, Some(error.code), None, None);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::telemetry::service::{Context, Sender};

    #[test]
    fn a_failure_ships_the_command_and_code_and_not_the_message() {
        let dir = tempfile::tempdir().expect("tmp");
        let context = Context {
            install_id: "i".into(),
            session_id: "s".into(),
            app_version: "1".into(),
            build_channel: "production".into(),
            platform: "linux".into(),
            arch: "x64".into(),
            locale: "en".into(),
            timezone_offset_minutes: 0,
        };
        let service = Arc::new(Service::start(
            dir.path(),
            context,
            Sender::new(
                "http://127.0.0.1:1/x",
                crate::seams::transport::NativeTransport::loopback(),
            ),
            true,
        ));
        TelemetryFailureSink(service.clone()).report(
            "vault_select",
            FailureDetails {
                kind: "storage",
                code: "storage_corrupt",
                message: "/Users/kaan/Notes broke",
            },
        );
        let queued = service.queued();
        assert_eq!(queued.len(), 1);
        let event = &queued[0];
        assert_eq!(
            (
                event.name.as_str(),
                event.action.as_str(),
                event.error_code.as_deref()
            ),
            ("app_log_recorded", "warn", Some("storage_corrupt"))
        );
        assert_eq!(
            event.dimensions.as_ref().expect("dim")["log_action"],
            "vault_select"
        );
        assert!(event.error.is_none());
    }
}
