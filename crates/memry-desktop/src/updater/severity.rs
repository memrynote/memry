//! Which updater failures are defects and which are a laptop on a train
//! (`apps/desktop/src/main/updater-error-severity.ts`, `updater-error-description.ts`).
//! Nothing is dropped: a demoted failure still ships, as a warning instead of an exception.
//! Electron read Chromium `net::ERR_*` tokens out of the message; the Velopack client reports
//! typed errors, which the Tauri crate maps into [`UpdateErrorKind`].

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

/// Where in the update lifecycle a failure happened. The tokens are a telemetry contract: they
/// ship verbatim as the `phase` field and as the telemetry action.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UpdaterErrorPhase {
    StartupCheck,
    ScheduledCheck,
    AutoCheckEnable,
    AutoDownloadEnable,
    Check,
    Download,
    Downloaded,
    Install,
    Idle,
}

impl UpdaterErrorPhase {
    pub const ALL: [Self; 9] = [
        Self::StartupCheck,
        Self::ScheduledCheck,
        Self::AutoCheckEnable,
        Self::AutoDownloadEnable,
        Self::Check,
        Self::Download,
        Self::Downloaded,
        Self::Install,
        Self::Idle,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::StartupCheck => "startup-check",
            Self::ScheduledCheck => "scheduled-check",
            Self::AutoCheckEnable => "auto-check-enable",
            Self::AutoDownloadEnable => "auto-download-enable",
            Self::Check => "check",
            Self::Download => "download",
            Self::Downloaded => "downloaded",
            Self::Install => "install",
            Self::Idle => "idle",
        }
    }

    /// Only a check can be demoted. A transport failure while downloading or installing can
    /// leave a half-applied update, so it stays an error.
    pub fn is_check(self) -> bool {
        matches!(
            self,
            Self::Check | Self::StartupCheck | Self::ScheduledCheck | Self::AutoCheckEnable
        )
    }
}

/// How the device failed to reach the feed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NetworkKind {
    HostNotFound,
    ConnectionFailed,
    Timeout,
    Reset,
    Unreachable,
    /// A transport failure nobody has reasoned about, such as TLS: a security signal, not a
    /// connectivity drop.
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateErrorKind {
    Network(NetworkKind),
    /// The server answered with this HTTP status.
    Status(u16),
    /// The app runs from a read-only volume (the mounted DMG, a translocated copy).
    ReadOnlyVolume,
    Other,
}

/// One failure of an update backend.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateError {
    pub message: String,
    pub kind: UpdateErrorKind,
    /// The `source()` chain below `message`, outermost first.
    pub causes: Vec<String>,
}

impl UpdateError {
    pub fn new(kind: UpdateErrorKind, message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            kind,
            causes: Vec::new(),
        }
    }
}

impl std::fmt::Display for UpdateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for UpdateError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    Warn,
    Error,
}

/// `Warn` for a check that could not reach the network and for an app on a read-only volume.
/// Fails closed: an HTTP status, an unrecognised transport failure and anything outside a check
/// phase stay `Error`.
pub fn classify(error: &UpdateError, phase: UpdaterErrorPhase) -> Severity {
    // Any phase: the user is told to move the app, nothing in the app can repair it.
    if error.kind == UpdateErrorKind::ReadOnlyVolume {
        return Severity::Warn;
    }
    if !phase.is_check() {
        return Severity::Error;
    }
    match error.kind {
        UpdateErrorKind::Network(NetworkKind::Other) => Severity::Error,
        UpdateErrorKind::Network(_) => Severity::Warn,
        _ => Severity::Error,
    }
}

const ERROR_TEXT_CAP: usize = 300;
const MAX_CAUSE_DEPTH: usize = 4;

fn truncate(text: &str, limit: usize) -> String {
    match text.char_indices().nth(limit) {
        Some((at, _)) => format!("{}…", &text[..at]),
        None => text.to_owned(),
    }
}

fn error_name(kind: UpdateErrorKind) -> &'static str {
    match kind {
        UpdateErrorKind::Network(_) => "NetworkError",
        UpdateErrorKind::Status(_) => "HttpError",
        UpdateErrorKind::ReadOnlyVolume => "ReadOnlyVolumeError",
        UpdateErrorKind::Other => "UpdateError",
    }
}

fn error_code(kind: UpdateErrorKind) -> Option<String> {
    let network = |code: &str| Some(code.to_owned());
    match kind {
        UpdateErrorKind::Network(NetworkKind::HostNotFound) => network("HOST_NOT_FOUND"),
        UpdateErrorKind::Network(NetworkKind::ConnectionFailed) => network("CONNECTION_FAILED"),
        UpdateErrorKind::Network(NetworkKind::Timeout) => network("TIMEOUT"),
        UpdateErrorKind::Network(NetworkKind::Reset) => network("CONNECTION_RESET"),
        UpdateErrorKind::Network(NetworkKind::Unreachable) => network("UNREACHABLE"),
        UpdateErrorKind::Network(NetworkKind::Other) => network("NETWORK_OTHER"),
        // builder-util-runtime's code for the same failure, so one Loki query spans both apps.
        UpdateErrorKind::Status(status) => Some(format!("HTTP_ERROR_{status}")),
        UpdateErrorKind::ReadOnlyVolume | UpdateErrorKind::Other => None,
    }
}

/// The failure as log fields. The names are the redaction allowlist's: `phase` and `errorCode`
/// ship verbatim, the rest are text-redacted and capped. Rust errors carry no stack, so there
/// is no `errorStack`.
pub fn describe_error(error: &UpdateError, phase: UpdaterErrorPhase) -> Value {
    let mut fields = Map::new();
    fields.insert("phase".into(), json!(phase.as_str()));
    fields.insert("errorName".into(), json!(error_name(error.kind)));
    fields.insert(
        "errorMessage".into(),
        json!(truncate(&error.message, ERROR_TEXT_CAP)),
    );
    if let Some(code) = error_code(error.kind) {
        fields.insert("errorCode".into(), json!(code));
    }
    if let UpdateErrorKind::Status(status) = error.kind {
        fields.insert("httpStatus".into(), json!(status));
    }
    let causes: Vec<&str> = error
        .causes
        .iter()
        .take(MAX_CAUSE_DEPTH)
        .map(String::as_str)
        .collect();
    if !causes.is_empty() {
        fields.insert(
            "errorCause".into(),
            json!(truncate(&causes.join(" <- "), ERROR_TEXT_CAP)),
        );
    }
    Value::Object(fields)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn network(kind: NetworkKind) -> UpdateError {
        UpdateError::new(UpdateErrorKind::Network(kind), "offline")
    }

    #[test]
    fn phase_tokens_are_the_electron_strings() {
        let tokens: Vec<&str> = UpdaterErrorPhase::ALL.iter().map(|p| p.as_str()).collect();
        assert_eq!(
            tokens,
            [
                "startup-check",
                "scheduled-check",
                "auto-check-enable",
                "auto-download-enable",
                "check",
                "download",
                "downloaded",
                "install",
                "idle"
            ]
        );
        for phase in UpdaterErrorPhase::ALL {
            assert_eq!(
                serde_json::to_value(phase).unwrap(),
                json!(phase.as_str()),
                "serde and as_str agree"
            );
        }
    }

    #[test]
    fn a_connectivity_drop_in_a_check_is_a_warning() {
        let transient = [
            NetworkKind::HostNotFound,
            NetworkKind::ConnectionFailed,
            NetworkKind::Timeout,
            NetworkKind::Reset,
            NetworkKind::Unreachable,
        ];
        for phase in UpdaterErrorPhase::ALL.into_iter().filter(|p| p.is_check()) {
            for kind in transient {
                assert_eq!(
                    classify(&network(kind), phase),
                    Severity::Warn,
                    "{phase:?} {kind:?}"
                );
            }
        }
    }

    #[test]
    fn an_unrecognised_transport_failure_or_an_answer_stays_an_error() {
        let check = UpdaterErrorPhase::Check;
        assert_eq!(
            classify(&network(NetworkKind::Other), check),
            Severity::Error
        );
        for status in [403, 404, 500, 618] {
            let error = UpdateError::new(UpdateErrorKind::Status(status), "no");
            assert_eq!(classify(&error, check), Severity::Error, "{status}");
        }
        let other = UpdateError::new(UpdateErrorKind::Other, "checksum mismatch");
        assert_eq!(classify(&other, check), Severity::Error);
    }

    #[test]
    fn the_same_drop_outside_a_check_stays_an_error() {
        let others = [
            UpdaterErrorPhase::Download,
            UpdaterErrorPhase::Downloaded,
            UpdaterErrorPhase::Install,
            UpdaterErrorPhase::AutoDownloadEnable,
            UpdaterErrorPhase::Idle,
        ];
        for phase in others {
            assert!(!phase.is_check());
            assert_eq!(
                classify(&network(NetworkKind::HostNotFound), phase),
                Severity::Error
            );
            assert_eq!(
                classify(&network(NetworkKind::Unreachable), phase),
                Severity::Error
            );
        }
    }

    #[test]
    fn a_read_only_volume_is_a_warning_in_every_phase() {
        let error = UpdateError::new(UpdateErrorKind::ReadOnlyVolume, "read-only");
        for phase in UpdaterErrorPhase::ALL {
            assert_eq!(classify(&error, phase), Severity::Warn, "{phase:?}");
        }
    }

    #[test]
    fn describes_a_failure_as_capped_log_fields() {
        let mut error = UpdateError::new(UpdateErrorKind::Status(404), "x".repeat(400));
        error.causes = (1..=6).map(|n| format!("cause {n}")).collect();
        let fields = describe_error(&error, UpdaterErrorPhase::ScheduledCheck);
        assert_eq!(fields["phase"], "scheduled-check");
        assert_eq!(fields["errorName"], "HttpError");
        assert_eq!(fields["errorCode"], "HTTP_ERROR_404");
        assert_eq!(fields["httpStatus"], 404);
        assert_eq!(
            fields["errorMessage"].as_str().unwrap(),
            format!("{}…", "x".repeat(300))
        );
        assert_eq!(
            fields["errorCause"],
            "cause 1 <- cause 2 <- cause 3 <- cause 4"
        );
        assert!(fields.get("errorStack").is_none());
    }

    #[test]
    fn a_plain_failure_carries_no_code_status_or_cause() {
        let error = UpdateError::new(UpdateErrorKind::Other, "boom");
        assert_eq!(
            describe_error(&error, UpdaterErrorPhase::Install),
            json!({ "phase": "install", "errorName": "UpdateError", "errorMessage": "boom" })
        );
    }
}
