//! Readwise telemetry (`telemetry.ts`, D12). Every payload is a count, a duration or a short
//! error code: never a title, a highlight, a URL or the token. The allowlist in
//! `telemetry::events` holds the event names. The caller tracks the events (33e: the scheduler,
//! the run command and the connect commands).

use super::client::ReadwiseError;
use super::run_status::kind_code;
use super::run_types::{RunError, RunResult};
use crate::telemetry::events::{Metrics, TelemetryEvent, to_safe_token};
use crate::telemetry::service::Service;

/// How a run started.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    Scheduled,
    Manual,
}

/// How the token arrived: pasted on connect, or pasted again on a takeover (D8).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectSource {
    Token,
    Takeover,
}

/// `readwiseErrorCode`: a stable, bounded code. Never the error's message, which can hold a URL.
pub fn error_code(error: &RunError) -> String {
    match error {
        RunError::Readwise(error) => readwise_code(error),
        RunError::Gate(error) => error.code().to_owned(),
        RunError::AlreadyRunning | RunError::Failed(_) => "unexpected".to_owned(),
    }
}

fn readwise_code(error: &ReadwiseError) -> String {
    let code = error.kind().map_or("unexpected", kind_code);
    to_safe_token(code, "unexpected")
}

fn event(name: &str, action: &str, source: &str, result: &str) -> TelemetryEvent {
    let mut event = Service::event(name, "vault", action);
    event.source = Some(source.to_owned());
    event.result = Some(result.to_owned());
    event
}

/// `trackReadwiseConnected`.
pub fn connected(source: ConnectSource, error: Option<&ReadwiseError>) -> TelemetryEvent {
    let source = match source {
        ConnectSource::Token => "token",
        ConnectSource::Takeover => "takeover",
    };
    let result = if error.is_some() { "failed" } else { "success" };
    let mut event = event("readwise_connected", "connected", source, result);
    event.error_code = error.map(readwise_code);
    event
}

/// `trackReadwiseDisconnected`.
pub fn disconnected() -> TelemetryEvent {
    event("readwise_disconnected", "disconnected", "token", "success")
}

/// `trackReadwiseSync`: one scheduled or manual run.
pub fn sync_completed(
    origin: Origin,
    duration_ms: u64,
    outcome: Result<&RunResult, &RunError>,
) -> TelemetryEvent {
    let source = match origin {
        Origin::Scheduled => "scheduled",
        Origin::Manual => "manual",
    };
    let result = match outcome {
        Err(_) => "failed",
        Ok(result) if result.cancelled => "canceled",
        Ok(result) if result.counts.failed > 0 => "failed",
        Ok(_) => "success",
    };
    let mut event = event("readwise_sync_completed", "sync_completed", source, result);
    let mut metrics = Metrics {
        duration_ms: Some(duration_ms as f64),
        ..Metrics::default()
    };
    match outcome {
        Err(error) => event.error_code = Some(error_code(error)),
        Ok(result) => {
            let counts = &result.counts;
            let items = counts.added + counts.updated + counts.appended + result.documents;
            metrics.item_count = Some(items as f64);
            metrics.result_count = Some(counts.highlights as f64);
            metrics.value = Some(counts.failed as f64);
        }
    }
    event.metrics = Some(metrics);
    event
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::readwise::run_state::RunCounts;

    #[test]
    fn every_event_is_on_the_allowlist_and_carries_counts_and_codes_only() {
        let result = RunResult {
            counts: RunCounts {
                added: 1,
                updated: 2,
                appended: 3,
                highlights: 7,
                failed: 1,
                ..RunCounts::default()
            },
            documents: 4,
            ..RunResult::default()
        };
        let run = sync_completed(Origin::Scheduled, 1200, Ok(&result));
        assert!(run.is_known());
        assert_eq!(run.result.as_deref(), Some("failed"));
        let metrics = run.metrics.unwrap();
        assert_eq!(metrics.item_count, Some(10.0));
        assert_eq!(
            (metrics.result_count, metrics.value),
            (Some(7.0), Some(1.0))
        );

        let cancelled = RunResult {
            cancelled: true,
            ..RunResult::default()
        };
        let stopped = sync_completed(Origin::Manual, 5, Ok(&cancelled));
        assert_eq!(stopped.result.as_deref(), Some("canceled"));

        let token = RunError::Readwise(ReadwiseError::InvalidToken { status: 401 });
        let failed = sync_completed(Origin::Manual, 5, Err(&token));
        assert!(failed.is_known());
        assert_eq!(failed.error_code.as_deref(), Some("invalid-token"));
        let unexpected = RunError::Failed("https://readwise.io/secret path".to_owned());
        assert_eq!(error_code(&unexpected), "unexpected");

        for event in [connected(ConnectSource::Takeover, None), disconnected()] {
            assert!(event.is_known(), "{}", event.name);
            assert_eq!(event.result.as_deref(), Some("success"));
        }
        let refused = ReadwiseError::InvalidToken { status: 401 };
        let refused = connected(ConnectSource::Token, Some(&refused));
        assert_eq!(refused.error_code.as_deref(), Some("invalid-token"));
    }
}
