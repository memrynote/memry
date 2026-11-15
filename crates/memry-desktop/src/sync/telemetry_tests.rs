//! Ports of `sync-error-telemetry.test.ts` and `bootstrap-metrics.consent.test.ts`, plus the
//! supervisor's emissions, through a real telemetry [`Service`].

use std::sync::Arc;

use memry_core::api::errors::{ApiError, StorageError, SyncError, TransportError};
use memry_core::sync::driver::{AppliedOutcome, AppliedRecord, FieldConflict};
use serde_json::json;

use super::*;
use crate::sync::supervisor::rig::{Rig, lock, settle};
use crate::telemetry::service::{Context, Sender};

fn service(dir: &tempfile::TempDir, enabled: bool) -> Arc<Service> {
    let context = Context {
        install_id: "550e8400-e29b-41d4-a716-446655440000".into(),
        session_id: "550e8400-e29b-41d4-a716-446655440001".into(),
        app_version: "0.1.0".into(),
        build_channel: "production".into(),
        platform: "darwin".into(),
        arch: "arm64".into(),
        locale: "en".into(),
        timezone_offset_minutes: 0,
    };
    let sender = Sender::new(
        "http://127.0.0.1:1/telemetry/batch",
        crate::seams::transport::NativeTransport::loopback(),
    );
    Arc::new(Service::start(dir.path(), context, sender, enabled))
}

fn status(status: u16, code: Option<&str>, message: &str) -> SyncError {
    SyncError::Api {
        source: ApiError::Status {
            status,
            code: code.map(str::to_owned),
            message: message.to_owned(),
        },
    }
}

fn fields(error: &SyncError) -> TelemetryEvent {
    sync_error_event(error, str::to_owned)
}

fn failure(http_status: Option<u16>, code: Option<&str>, retryable: bool) -> FailureDetail {
    FailureDetail {
        http_status,
        server_code: code.map(str::to_owned),
        retryable: Some(retryable),
    }
}

/// #1584: a permanent 400 and a transient 503 used to ship as one opaque `server_error`.
#[test]
fn a_400_validation_error_ships_status_code_retryable_and_message() {
    let event = fields(&status(
        400,
        Some("VALIDATION_ERROR"),
        "Record sync item type \"calendar_external_event\" requires clock metadata",
    ));
    assert_eq!(event.name, "sync_error");
    assert_eq!(event.error_code.as_deref(), Some("server_error"));
    assert_eq!(
        event.failure,
        Some(failure(Some(400), Some("VALIDATION_ERROR"), false))
    );
    let message = event.error.and_then(|e| e.message).unwrap();
    assert!(message.contains("requires clock metadata"), "{message}");
}

#[test]
fn a_503_with_no_code_is_told_apart_from_the_400() {
    let client = fields(&status(400, Some("VALIDATION_ERROR"), "nope"));
    let server = fields(&status(503, None, "Server returned 503"));
    assert_eq!(server.failure, Some(failure(Some(503), None, true)));
    assert_eq!(server.error_code, client.error_code);
    assert_ne!(server.failure, client.failure);
}

#[test]
fn a_413_quota_code_lands_in_its_own_field() {
    let event = fields(&status(
        413,
        Some("STORAGE_QUOTA_EXCEEDED"),
        "Storage quota exceeded",
    ));
    assert_eq!(event.error_code.as_deref(), Some("storage_quota_exceeded"));
    assert_eq!(
        event.failure,
        Some(failure(Some(413), Some("STORAGE_QUOTA_EXCEEDED"), false))
    );
}

#[test]
fn a_failure_with_no_http_request_ships_only_the_retryable_verdict() {
    let event = fields(&SyncError::Api {
        source: ApiError::Transport {
            source: TransportError::Failed {
                what: "fetch failed".into(),
            },
        },
    });
    assert_eq!(event.error_code.as_deref(), Some("network_offline"));
    assert_eq!(event.failure, Some(failure(None, None, true)));
    assert!(event.error.and_then(|e| e.message).is_some());
}

#[test]
fn a_home_path_in_the_message_is_redacted_before_it_ships() {
    let dir = tempfile::tempdir().unwrap();
    let service = service(&dir, true);
    let event = sync_error_event(
        &SyncError::Storage {
            source: StorageError::Failed {
                what: "ENOENT: no such file or directory, open '/Users/kaan/Vault/Secret.md'"
                    .into(),
            },
        },
        |m| service.redact_message(m),
    );
    let message = event.error.and_then(|e| e.message).unwrap();
    assert!(!message.contains("/Users/kaan"), "{message}");
    assert!(!message.contains("Secret.md"), "{message}");
}

#[test]
fn an_over_long_message_is_cut_to_the_schema_limit() {
    let event = fields(&status(500, None, &"server unavailable ".repeat(100)));
    let message = event.error.and_then(|e| e.message).unwrap();
    assert_eq!(message.chars().count(), 512);
}

fn run_bootstrap(metrics: &BootstrapMetrics) {
    metrics.begin(BootstrapSource::VaultDownload);
    metrics.mark_interactive();
}

/// `bootstrap-metrics.consent.test.ts` through the real service: consent off queues nothing.
/// Electron's 5 events are interactive + full text + 3 throughput; L4b ports the interactive
/// mark only (full text and bytes come with the body pull).
#[tokio::test(start_paused = true)]
async fn bootstrap_milestones_ship_only_with_consent() {
    let dir = tempfile::tempdir().unwrap();
    let off = service(&dir, false);
    run_bootstrap(&BootstrapMetrics::new(Some(Arc::clone(&off))));
    assert_eq!(off.queue_depth(), 0);

    let dir = tempfile::tempdir().unwrap();
    let on = service(&dir, true);
    run_bootstrap(&BootstrapMetrics::new(Some(Arc::clone(&on))));
    let queued = on.queued();
    assert_eq!(queued.len(), 1);
    assert_eq!(
        (queued[0].name.as_str(), queued[0].action.as_str()),
        ("sync_bootstrap", "interactive")
    );
    assert_eq!(queued[0].source.as_deref(), Some("vault_download"));
}

#[tokio::test(start_paused = true)]
async fn the_interactive_mark_is_once_per_window_and_abandon_closes_it_silently() {
    let dir = tempfile::tempdir().unwrap();
    let service = service(&dir, true);
    let metrics = BootstrapMetrics::new(Some(Arc::clone(&service)));
    metrics.mark_interactive();
    assert_eq!(service.queue_depth(), 0, "no window, no event");
    metrics.begin(BootstrapSource::FirstFullSync);
    metrics.begin(BootstrapSource::VaultDownload);
    metrics.mark_interactive();
    tokio::time::sleep(Duration::from_secs(61)).await;
    metrics.mark_interactive();
    assert_eq!(service.queue_depth(), 1, "once per window");
    assert_eq!(
        service.queued()[0].source.as_deref(),
        Some("first_full_sync")
    );

    metrics.abandon();
    assert!(!metrics.is_active());
    metrics.begin(BootstrapSource::VaultDownload);
    metrics.mark_interactive();
    assert_eq!(service.queue_depth(), 2, "a new window");
    metrics.abandon();
    metrics.begin(BootstrapSource::VaultDownload);
    metrics.mark_interactive();
    assert_eq!(service.queue_depth(), 2, "at most once a minute");
}

/// The supervisor reports a failed pass as `sync_error` and a merged record as
/// `conflict_resolved`, and nothing at all while telemetry is off.
#[tokio::test(start_paused = true)]
async fn the_supervisor_reports_failures_and_conflicts_only_with_consent() {
    for enabled in [true, false] {
        let dir = tempfile::tempdir().unwrap();
        let service = service(&dir, enabled);
        let mut rig = Rig::new();
        rig.telemetry = Some(Arc::clone(&service));
        lock(&rig.backend.driver.errors).push(status(503, None, "unavailable"));
        let supervisor = rig.start().await;
        settle().await;
        let observers = lock(&rig.backend.driver.observers).clone();
        assert_eq!(observers.len(), 1, "one observer per driver");
        observers[0].records_applied(&[AppliedRecord {
            item_type: "task".into(),
            item_id: "t1".into(),
            outcome: AppliedOutcome::Updated,
            conflicts: vec![FieldConflict {
                field: "title".into(),
                losing: json!("a"),
                winning: json!("b"),
                merged_clock: json!({}),
            }],
        }]);
        let names: Vec<(String, Option<String>)> = service
            .queued()
            .into_iter()
            .map(|e| (e.name, e.error_code))
            .collect();
        if enabled {
            assert_eq!(
                names,
                [
                    ("sync_error".to_owned(), Some("server_error".to_owned())),
                    ("app_log_recorded".to_owned(), Some("task".to_owned())),
                ]
            );
        } else {
            assert!(names.is_empty(), "{names:?}");
        }
        supervisor.stop().await;
    }
}
