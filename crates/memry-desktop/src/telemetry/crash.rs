//! Unclean-shutdown detection: `session-marker.json` is written at launch, refreshed every
//! minute and removed on a clean quit. A marker found at the next launch means the previous
//! session died, and that launch reports it as `app_crashed`
//! (`apps/desktop/src/main/telemetry/crash-marker.ts`).

use std::fs;
use std::path::PathBuf;

use serde_json::{Map, Value};

use super::time::{iso, now_ms, parse_iso};

pub const FILE_NAME: &str = "session-marker.json";
/// How often the shell calls [`CrashMarker::refresh`].
pub const ALIVE_INTERVAL_MS: u64 = 60_000;

/// What the next launch learned from a leftover marker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CrashReport {
    pub error_code: String,
    pub message: String,
    pub duration_ms: Option<u64>,
    pub prior_app_version: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShutdownFailure {
    Timeout,
    CleanupError,
}

impl ShutdownFailure {
    fn wire(self) -> &'static str {
        match self {
            Self::Timeout => "timeout",
            Self::CleanupError => "cleanup_error",
        }
    }
}

pub struct CrashMarker {
    path: PathBuf,
    session_id: String,
    app_version: String,
    started_at: String,
    installed: bool,
}

/// `^[a-z][a-z0-9-]{0,39}$`
fn is_step_token(value: &str) -> bool {
    let b = value.as_bytes();
    (1..=40).contains(&b.len())
        && b[0].is_ascii_lowercase()
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

/// `^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$`: what may appear in a shipped message.
fn is_field_token(value: &str) -> bool {
    let b = value.as_bytes();
    (1..=40).contains(&b.len())
        && b[0].is_ascii_alphanumeric()
        && b.iter()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
}

fn field(value: Option<&str>, fallback: &str) -> String {
    value
        .filter(|v| is_field_token(v))
        .unwrap_or(fallback)
        .to_owned()
}

impl CrashMarker {
    pub fn new(data_dir: &std::path::Path, session_id: &str, app_version: &str) -> Self {
        Self {
            path: data_dir.join(FILE_NAME),
            session_id: session_id.to_owned(),
            app_version: app_version.to_owned(),
            started_at: iso(now_ms()),
            installed: false,
        }
    }

    fn read(&self) -> Option<Map<String, Value>> {
        match serde_json::from_str(&fs::read_to_string(&self.path).ok()?) {
            Ok(Value::Object(map)) => Some(map),
            _ => None,
        }
    }

    /// The report for a marker left by the previous session, `None` when it quit cleanly. Call
    /// once per launch, before [`CrashMarker::install`].
    pub fn detect(&self) -> Option<CrashReport> {
        let raw = fs::read_to_string(&self.path).ok()?;
        let marker = match serde_json::from_str::<Value>(&raw) {
            Ok(Value::Object(map)) => Some(map),
            _ => None,
        };
        let text = |key: &str| {
            marker
                .as_ref()
                .and_then(|m| m.get(key))
                .and_then(Value::as_str)
        };
        let duration_ms = match (
            text("startedAt").and_then(parse_iso),
            text("lastAliveAt").and_then(parse_iso),
        ) {
            (Some(start), Some(alive)) => Some(alive.saturating_sub(start)),
            _ => None,
        };
        let step = text("shutdownStep");
        let error_code = match text("shutdownFailure") {
            Some("timeout") => match step.filter(|s| is_step_token(s)) {
                Some(step) => format!("SHUTDOWN_TIMEOUT_{}", step.replace('-', "_").to_uppercase()),
                None => "SHUTDOWN_TIMEOUT".to_owned(),
            },
            Some("cleanup_error") => "SHUTDOWN_CLEANUP_FAILED".to_owned(),
            _ => "UNCLEAN_SHUTDOWN".to_owned(),
        };
        let version = text("appVersion");
        let message: String = [
            format!(
                "Unclean shutdown [failure={}]",
                field(text("shutdownFailure"), "none")
            ),
            format!("[step={}]", field(step, "unknown")),
            format!("[prior_version={}]", field(version, "unknown")),
            format!(
                "[uptime_ms={}]",
                duration_ms.map_or("unknown".to_owned(), |d| d.to_string())
            ),
            format!(
                "[marker={}]",
                if marker.is_some() {
                    "parsed"
                } else {
                    "unreadable"
                }
            ),
        ]
        .join(" ")
        .chars()
        .take(512)
        .collect();
        Some(CrashReport {
            error_code,
            message,
            duration_ms,
            prior_app_version: version.map(str::to_owned),
        })
    }

    fn write(&self, mut marker: Map<String, Value>) -> std::io::Result<()> {
        marker.insert("lastAliveAt".into(), Value::String(iso(now_ms())));
        fs::write(&self.path, Value::Object(marker).to_string())
    }

    fn fresh(&self) -> Map<String, Value> {
        Map::from_iter([
            (
                "sessionId".to_owned(),
                Value::String(self.session_id.clone()),
            ),
            (
                "startedAt".to_owned(),
                Value::String(self.started_at.clone()),
            ),
            (
                "appVersion".to_owned(),
                Value::String(self.app_version.clone()),
            ),
        ])
    }

    /// Writes this session's marker. Never fails the launch: a read-only disk only loses detection.
    pub fn install(&mut self) {
        match self.write(self.fresh()) {
            Ok(()) => self.installed = true,
            Err(error) => tracing::warn!(
                scope = "CrashMarker",
                "failed to write crash marker; unclean shutdowns will go undetected: {error}"
            ),
        }
    }

    /// The alive tick. Keeps a shutdown stamp already on disk.
    pub fn refresh(&self) {
        if !self.installed {
            return;
        }
        let marker = self.read().unwrap_or_else(|| self.fresh());
        let _ = self.write(marker);
    }

    fn stamp(&self, update: impl FnOnce(&mut Map<String, Value>)) {
        if !self.installed {
            return;
        }
        let Some(mut marker) = self.read() else {
            return;
        };
        update(&mut marker);
        let _ = self.write(marker);
    }

    /// Records the shutdown step that is starting, before it runs.
    pub fn mark_shutdown_step(&self, step: &str) {
        self.stamp(|m| {
            m.insert("shutdownStep".into(), Value::String(step.to_owned()));
        });
    }

    pub fn mark_shutdown_failure(&self, reason: ShutdownFailure, step: Option<&str>) {
        self.stamp(|m| {
            m.insert(
                "shutdownFailure".into(),
                Value::String(reason.wire().to_owned()),
            );
            if let Some(step) = step {
                m.insert("shutdownStep".into(), Value::String(step.to_owned()));
            }
        });
    }

    /// Removes the marker on a clean quit. Only the process that wrote it may.
    pub fn clear(&mut self) {
        if !self.installed {
            return;
        }
        self.installed = false;
        if let Err(error) = fs::remove_file(&self.path) {
            tracing::warn!(
                scope = "CrashMarker",
                "failed to clear crash marker; next launch may report a false crash: {error}"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_clean_quit_leaves_nothing_to_report() {
        let dir = tempfile::tempdir().expect("tmp");
        let mut marker = CrashMarker::new(dir.path(), "s1", "1.2.3");
        assert_eq!(marker.detect(), None);
        marker.install();
        marker.clear();
        assert_eq!(CrashMarker::new(dir.path(), "s2", "1.2.3").detect(), None);
    }

    #[test]
    fn a_leftover_marker_reports_the_crash_with_the_prior_version() {
        let dir = tempfile::tempdir().expect("tmp");
        let mut dead = CrashMarker::new(dir.path(), "s1", "1.2.3");
        dead.install();
        drop(dead);
        let report = CrashMarker::new(dir.path(), "s2", "1.2.4")
            .detect()
            .expect("report");
        assert_eq!(report.error_code, "UNCLEAN_SHUTDOWN");
        assert_eq!(report.prior_app_version.as_deref(), Some("1.2.3"));
        assert!(
            report.message.contains("[prior_version=1.2.3]")
                && report.message.contains("[marker=parsed]")
        );
    }

    #[test]
    fn a_shutdown_stamp_names_the_step_and_survives_the_alive_tick() {
        let dir = tempfile::tempdir().expect("tmp");
        let mut dead = CrashMarker::new(dir.path(), "s1", "1.0.0");
        dead.install();
        dead.mark_shutdown_step("flush-sync");
        dead.mark_shutdown_failure(ShutdownFailure::Timeout, None);
        dead.refresh();
        let report = CrashMarker::new(dir.path(), "s2", "1.0.0")
            .detect()
            .expect("report");
        assert_eq!(report.error_code, "SHUTDOWN_TIMEOUT_FLUSH_SYNC");
        assert!(
            report
                .message
                .contains("[failure=timeout] [step=flush-sync]")
        );
    }

    #[test]
    fn a_hand_edited_marker_cannot_put_free_text_in_a_message() {
        let dir = tempfile::tempdir().expect("tmp");
        fs::write(
            dir.path().join(FILE_NAME),
            r#"{"shutdownFailure":"timeout","shutdownStep":"/Users/kaan/x","appVersion":"a b@c"}"#,
        )
        .expect("edit");
        let report = CrashMarker::new(dir.path(), "s", "1")
            .detect()
            .expect("report");
        assert_eq!(report.error_code, "SHUTDOWN_TIMEOUT");
        assert!(
            report
                .message
                .contains("[step=unknown] [prior_version=unknown]")
        );
        fs::write(dir.path().join(FILE_NAME), "not json").expect("tear");
        let torn = CrashMarker::new(dir.path(), "s", "1")
            .detect()
            .expect("still a crash");
        assert!(torn.message.contains("[marker=unreadable]"));
    }

    #[test]
    fn only_the_installing_process_removes_the_marker() {
        let dir = tempfile::tempdir().expect("tmp");
        let mut first = CrashMarker::new(dir.path(), "s1", "1");
        first.install();
        CrashMarker::new(dir.path(), "s2", "1").clear();
        assert!(dir.path().join(FILE_NAME).exists());
    }
}
