//! The NSIS leftover as the updater reports it.

use std::sync::atomic::Ordering;

use super::*;
use crate::updater::nsis_leftover::tests::{FakeHost, electron_install, registration_for};
use crate::updater::nsis_leftover::{GRACE_MS, LeftoverState, STATE_FILENAME};

/// A leftover an earlier launch found more than a day ago.
fn found_a_day_ago(rig: &Rig) -> (PathBuf, FakeHost) {
    let nsis = rig
        .dir
        .path()
        .canonicalize()
        .unwrap()
        .join("Programs")
        .join("Memrynote");
    electron_install(&nsis);
    let state = LeftoverState {
        first_seen_at: Some(now_ms() - GRACE_MS - 1),
        install_location: Some(nsis.to_string_lossy().into_owned()),
        ..LeftoverState::default()
    };
    std::fs::write(
        rig.dir.path().join(STATE_FILENAME),
        serde_json::to_vec(&state).unwrap(),
    )
    .unwrap();
    let host = FakeHost::default();
    *host.registration.lock().unwrap() = Some(registration_for(&nsis));
    (nsis, host)
}

#[tokio::test]
async fn a_removed_leftover_is_reported_as_the_migration() {
    let rig = rig();
    let (nsis, host) = found_a_day_ago(&rig);

    rig.service.retire_nsis_leftover(&host, &[], &[], None);

    assert!(!nsis.exists());
    let events = rig.telemetry.queued();
    let event = events
        .iter()
        .find(|event| event.name == "app_update_installed")
        .expect("the migration event");
    assert_eq!(
        (
            event.action.as_str(),
            event.source.as_deref(),
            event.result.as_deref()
        ),
        ("migrated", Some("electron-updater"), Some("success"))
    );
    assert_eq!(event.object_type.as_deref(), Some("nsis_install"));
}

#[tokio::test]
async fn a_kept_leftover_is_reported_once_with_its_reason() {
    let rig = rig();
    let (nsis, host) = found_a_day_ago(&rig);
    std::fs::write(nsis.join("notes.txt"), b"mine").unwrap();

    rig.service.retire_nsis_leftover(&host, &[], &[], None);
    rig.service.retire_nsis_leftover(&host, &[], &[], None);

    let failures: Vec<_> = rig
        .telemetry
        .queued()
        .into_iter()
        .filter(|event| event.error_code.as_deref() == Some("NSIS_CLEANUP_FAILED"))
        .collect();
    assert_eq!(failures.len(), 1, "{failures:?}");
    assert_eq!(
        failures[0]
            .dimensions
            .as_ref()
            .and_then(|dimensions| dimensions.get("skip_reason"))
            .map(String::as_str),
        Some("extra_entry")
    );
    assert!(nsis.join("notes.txt").exists());
}

#[tokio::test]
async fn nothing_is_removed_while_a_failed_install_is_live() {
    let rig = rig();
    let (nsis, host) = found_a_day_ago(&rig);
    rig.service
        .core
        .note_install_failed(Some("v2026-11-01".into()));

    rig.service.retire_nsis_leftover(&host, &[], &[], None);

    assert!(nsis.join("Memrynote.exe").exists());
    assert_eq!(host.deletes.load(Ordering::SeqCst), 0);
}
