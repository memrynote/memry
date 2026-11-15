//! What sync reports to telemetry: `sync_error` (`sync-error-telemetry.ts`), `conflict_resolved`
//! (`engine/conflict-report.ts:39`) and the fresh-device bootstrap milestones
//! (`bootstrap-metrics.ts`). Everything goes through [`Service`], which drops every event while
//! telemetry is off, so no consent check lives here.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use memry_core::api::errors::{ApiError, AuthError, SyncError};
use memry_core::sync::driver::{AppliedRecord, ApplyObserver};
use tokio::time::Instant;

use super::error_category::SyncErrorCategory;
use crate::session::lock;
use crate::telemetry::Service;
use crate::telemetry::events::{ErrorDetail, FailureDetail, Metrics, TelemetryEvent};
use crate::telemetry::main_warning::Level;

/// `TelemetryErrorDetailSchema.message` caps at 512 characters, and the server refuses a whole
/// batch for one invalid event.
const MAX_MESSAGE_CHARS: usize = 512;

/// The HTTP status and the server's code a failure carries, when it came from a response.
fn response_facts(error: &SyncError) -> (Option<u16>, Option<String>) {
    let api = match error {
        SyncError::Api { source } => source,
        SyncError::Auth {
            source: AuthError::Api { source },
        } => source,
        _ => return (None, None),
    };
    match api {
        ApiError::Status { status, code, .. } => (Some(*status), code.clone()),
        ApiError::Unauthorized { code, .. } => (Some(401), Some(code.clone())),
        ApiError::DeviceRevoked { .. } => (Some(403), Some("AUTH_DEVICE_REVOKED".to_owned())),
        ApiError::PaymentRequired { code, .. } => (Some(402), code.clone()),
        ApiError::UpgradeRequired { .. } => (Some(426), None),
        ApiError::RateLimited { .. } => (Some(429), None),
        _ => (None, None),
    }
}

/// `classifyError`'s retryable verdict (`sync-errors.ts`): the network, a `429`, a `5xx` and
/// whatever it cannot name are worth retrying; the rest needs the user or a new build.
fn retryable(category: SyncErrorCategory, status: Option<u16>) -> bool {
    match category {
        SyncErrorCategory::RateLimited
        | SyncErrorCategory::NetworkOffline
        | SyncErrorCategory::NetworkTimeout
        | SyncErrorCategory::Unknown => true,
        SyncErrorCategory::ServerError => status.is_none_or(|status| status >= 500),
        _ => false,
    }
}

/// `sync_error` for a failed pass: the category, the facts that make it actionable, and the
/// message after `redact` (the service's salted redaction), cut to 512 characters.
pub fn sync_error_event(error: &SyncError, redact: impl Fn(&str) -> String) -> TelemetryEvent {
    let category = SyncErrorCategory::of(error);
    let (http_status, server_code) = response_facts(error);
    let mut event = Service::event("sync_error", "sync", "full_failed");
    event.result = Some("failed".to_owned());
    event.source = Some("full".to_owned());
    event.error_code = Some(category.as_str().to_owned());
    event.dimensions = Some([("transport".to_owned(), "record".to_owned())].into());
    event.failure = Some(FailureDetail {
        http_status,
        server_code,
        retryable: Some(retryable(category, http_status)),
    });
    let message: String = redact(&error.to_string())
        .chars()
        .take(MAX_MESSAGE_CHARS)
        .collect();
    event.error = (!message.is_empty()).then(|| ErrorDetail {
        message: Some(message),
        ..ErrorDetail::default()
    });
    event
}

/// One `conflict_resolved` log per record a concurrent merge decided: the conflict rate per
/// item type is the field-merge strategy's health metric.
pub struct ConflictTelemetry(pub Arc<Service>);

impl ApplyObserver for ConflictTelemetry {
    fn name(&self) -> &str {
        "conflict-telemetry"
    }

    fn records_applied(&self, batch: &[AppliedRecord]) {
        for record in batch.iter().filter(|record| !record.conflicts.is_empty()) {
            self.0.track_main_log(
                Level::Info,
                "PullCoordinator",
                "conflict_resolved",
                Some(&record.item_type),
                None,
                None,
            );
        }
    }
}

/// What armed a bootstrap window: a vault downloaded from the account (the only source with a
/// time-to-interactive mark), or a first full sync with no cursor.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BootstrapSource {
    VaultDownload,
    FirstFullSync,
}

impl BootstrapSource {
    fn as_str(self) -> &'static str {
        match self {
            Self::VaultDownload => "vault_download",
            Self::FirstFullSync => "first_full_sync",
        }
    }
}

/// Each action leaves at most once a minute, behind the once-per-window flags.
const EMIT_WINDOW: Duration = Duration::from_secs(60);

struct Window {
    source: BootstrapSource,
    started: Instant,
    interactive_sent: bool,
}

/// The bootstrap window of one vault (`bootstrap-metrics.ts`). Never carries a note's content,
/// title, path or id.
pub struct BootstrapMetrics {
    service: Option<Arc<Service>>,
    window: Mutex<Option<Window>>,
    sent: Mutex<HashMap<&'static str, Instant>>,
}

impl BootstrapMetrics {
    pub fn new(service: Option<Arc<Service>>) -> Self {
        Self {
            service,
            window: Mutex::default(),
            sent: Mutex::default(),
        }
    }

    /// Opens the window; a window already open keeps its earlier, truer start.
    pub fn begin(&self, source: BootstrapSource) {
        let mut window = lock(&self.window);
        if window.is_none() {
            tracing::info!(source = source.as_str(), "bootstrap window opened");
            *window = Some(Window {
                source,
                started: Instant::now(),
                interactive_sent: false,
            });
        }
    }

    /// The vault open resolved: `time_to_interactive`, once per window.
    pub fn mark_interactive(&self) {
        let (source, elapsed) = {
            let mut window = lock(&self.window);
            let Some(window) = window.as_mut().filter(|w| !w.interactive_sent) else {
                return;
            };
            // Spent even when the throttle drops it, so the window never wedges on it.
            window.interactive_sent = true;
            (window.source, window.started.elapsed())
        };
        let Some(service) = self.service.as_ref().filter(|_| self.admit("interactive")) else {
            return;
        };
        let mut event = Service::event("sync_bootstrap", "sync", "interactive");
        event.source = Some(source.as_str().to_owned());
        event.result = Some("success".to_owned());
        event.metrics = Some(Metrics {
            duration_ms: Some(elapsed.as_millis() as f64),
            ..Metrics::default()
        });
        service.track_main_event(event);
    }

    /// Drops the window without a word: it no longer describes one vault's bootstrap.
    pub fn abandon(&self) {
        if let Some(window) = lock(&self.window).take() {
            tracing::info!(
                source = window.source.as_str(),
                "bootstrap window abandoned"
            );
        }
    }

    pub fn is_active(&self) -> bool {
        lock(&self.window).is_some()
    }

    fn admit(&self, action: &'static str) -> bool {
        let mut sent = lock(&self.sent);
        let now = Instant::now();
        if sent
            .get(action)
            .is_some_and(|at| now.duration_since(*at) < EMIT_WINDOW)
        {
            return false;
        }
        sent.insert(action, now);
        true
    }
}

#[cfg(test)]
#[path = "telemetry_tests.rs"]
mod tests;
