use serde_json::json;

use super::*;

const RAW: &str = "2026.1015.1";
const NOW: u64 = 1_793_525_415_123;

fn update(version: &str) -> AvailableUpdate {
    AvailableUpdate {
        version: version.into(),
        release_name: Some("November".into()),
        release_date: Some("2026-11-01".into()),
        release_notes: Some("Faster sync".into()),
        release_notes_html: Some("<p>Faster sync</p>".into()),
    }
}

#[test]
fn starts_idle_when_supported_and_unavailable_otherwise() {
    let core = UpdaterCore::new(RAW, true, NOW);
    assert_eq!(core.state().status, UpdaterStatus::Idle);
    assert_eq!(core.state().current_version, "v2026-10-15");
    assert!(core.state().update_supported);
    let core = UpdaterCore::new(RAW, false, NOW);
    assert_eq!(core.state().status, UpdaterStatus::Unavailable);
    assert!(!core.state().update_supported);
}

#[test]
fn serializes_to_the_ipc_contract_shape() {
    let core = UpdaterCore::new(RAW, true, NOW);
    assert_eq!(
        serde_json::to_value(core.state()).unwrap(),
        json!({
            "currentVersion": "v2026-10-15",
            "status": "idle",
            "updateSupported": true,
            "availableVersion": null,
            "releaseName": null,
            "releaseDate": null,
            "releaseNotes": null,
            "releaseNotesHtml": null,
            "downloadProgressPercent": null,
            "lastCheckedAt": null,
            "error": null,
            "autoDownloadEnabled": false,
            "autoCheckEnabled": true,
            "installFailed": null
        })
    );
    core.on_update_available(&update("2026.1101.1"), None, NOW);
    core.on_download_progress(42.0);
    core.note_install_failed(Some("v2026-11-01".into()));
    let value = serde_json::to_value(core.state()).unwrap();
    assert_eq!(value["status"], "downloading");
    assert_eq!(value["downloadProgressPercent"], 42);
    assert_eq!(value["installFailed"], json!({ "version": "v2026-11-01" }));
    core.on_version_skipped();
    assert_eq!(
        serde_json::to_value(core.state()).unwrap()["status"],
        "up-to-date"
    );
}

#[test]
fn every_status_serializes_to_its_contract_token() {
    let tokens = [
        (UpdaterStatus::Unavailable, "unavailable"),
        (UpdaterStatus::Idle, "idle"),
        (UpdaterStatus::Checking, "checking"),
        (UpdaterStatus::Available, "available"),
        (UpdaterStatus::Downloading, "downloading"),
        (UpdaterStatus::Downloaded, "downloaded"),
        (UpdaterStatus::Installing, "installing"),
        (UpdaterStatus::UpToDate, "up-to-date"),
        (UpdaterStatus::Error, "error"),
    ];
    for (status, token) in tokens {
        assert_eq!(serde_json::to_value(status).unwrap(), json!(token));
    }
}

#[test]
fn a_check_clears_the_error_and_progress_and_stamps_the_time() {
    let core = UpdaterCore::new(RAW, true, NOW);
    core.on_error("offline".into());
    core.on_checking(NOW + 5);
    let state = core.state();
    assert_eq!(state.status, UpdaterStatus::Checking);
    assert_eq!(state.error, None);
    assert_eq!(state.download_progress_percent, None);
    assert_eq!(state.last_checked_at, Some((NOW + 5) as i64));
}

#[test]
fn an_available_update_shows_its_display_version_and_notes() {
    let core = UpdaterCore::new(RAW, true, NOW);
    assert!(core.on_update_available(&update("2026.1101.2"), Some("v2026-10-20"), NOW));
    let state = core.state();
    assert_eq!(state.status, UpdaterStatus::Available);
    assert_eq!(state.available_version.as_deref(), Some("v2026-11-01.2"));
    assert_eq!(state.release_name.as_deref(), Some("November"));
    assert_eq!(
        state.release_notes_html.as_deref(),
        Some("<p>Faster sync</p>")
    );
}

#[test]
fn a_skipped_version_is_up_to_date_and_not_downloaded() {
    let core = UpdaterCore::new(RAW, true, NOW);
    core.on_update_available(&update("2026.1101.1"), None, NOW);
    assert!(!core.on_update_available(&update("2026.1101.1"), Some("v2026-11-01"), NOW));
    let state = core.state();
    assert_eq!(state.status, UpdaterStatus::UpToDate);
    assert_eq!(state.available_version, None);
    assert_eq!(state.release_notes, None);
    assert_eq!(state.release_notes_html, None);
}

#[test]
fn a_check_that_reached_the_feed_clears_the_failure_streak() {
    let day = 24 * 60 * 60 * 1000;
    let reaches: [fn(&UpdaterCore, u64); 2] = [
        |core, now| core.on_up_to_date(now),
        |core, now| {
            core.on_update_available(&update("2026.1101.1"), None, now);
        },
    ];
    for reach in reaches {
        let core = UpdaterCore::new(RAW, true, NOW);
        for n in 1..=5 {
            core.record_check_failure(NOW + day + n);
        }
        reach(&core, NOW + day + 6);
        assert_eq!(core.record_check_failure(NOW + day + 7), (1, false));
    }
}

#[test]
fn progress_is_rounded_half_up_and_clamped() {
    let core = UpdaterCore::new(RAW, true, NOW);
    for (percent, shown) in [
        (49.5, 50),
        (49.4, 49),
        (-3.0, 0),
        (140.0, 100),
        (f64::NAN, 0),
        (f64::INFINITY, 0),
    ] {
        core.on_download_progress(percent);
        assert_eq!(
            core.state().download_progress_percent,
            Some(shown),
            "{percent}"
        );
        assert_eq!(core.state().status, UpdaterStatus::Downloading);
    }
}

#[test]
fn a_started_download_keeps_its_progress_from_zero() {
    let core = UpdaterCore::new(RAW, true, NOW);
    core.on_error("previous".into());
    core.on_download_started();
    assert_eq!(core.state().download_progress_percent, Some(0));
    assert_eq!(core.state().error, None);
    core.on_download_progress(30.0);
    core.on_download_started();
    assert_eq!(core.state().download_progress_percent, Some(30));
}

#[test]
fn a_downloaded_update_is_complete() {
    let core = UpdaterCore::new(RAW, true, NOW);
    core.on_downloaded(&update("2026.1101.1"));
    let state = core.state();
    assert_eq!(state.status, UpdaterStatus::Downloaded);
    assert_eq!(state.download_progress_percent, Some(100));
    assert_eq!(state.available_version.as_deref(), Some("v2026-11-01"));
}

#[test]
fn the_failure_phase_follows_the_interrupted_status() {
    let core = UpdaterCore::new(RAW, true, NOW);
    assert_eq!(core.current_phase(), UpdaterErrorPhase::Idle);
    core.on_checking(NOW);
    assert_eq!(core.current_phase(), UpdaterErrorPhase::Check);
    core.on_download_started();
    assert_eq!(core.current_phase(), UpdaterErrorPhase::Download);
    core.on_downloaded(&update("2026.1101.1"));
    assert_eq!(core.current_phase(), UpdaterErrorPhase::Downloaded);
    core.on_installing();
    assert_eq!(core.current_phase(), UpdaterErrorPhase::Install);
    core.on_error("boom".into());
    assert_eq!(core.current_phase(), UpdaterErrorPhase::Idle);
    assert_eq!(core.state().error.as_deref(), Some("boom"));
}

#[test]
fn preferences_are_published_and_leave_the_rest_alone() {
    let core = UpdaterCore::new(RAW, true, NOW);
    core.on_update_available(&update("2026.1101.1"), None, NOW);
    core.set_auto_download_enabled(true);
    core.set_auto_check_enabled(false);
    let state = core.state();
    assert!(state.auto_download_enabled);
    assert!(!state.auto_check_enabled);
    assert_eq!(state.status, UpdaterStatus::Available);
}

#[test]
fn a_patch_cannot_change_the_version_or_support() {
    let core = UpdaterCore::new(RAW, false, NOW);
    core.patch(|state| {
        state.current_version = "forged".into();
        state.update_supported = true;
        state.auto_download_enabled = true;
    });
    let state = core.state();
    assert_eq!(state.current_version, "v2026-10-15");
    assert!(!state.update_supported);
    assert!(state.auto_download_enabled);
}

#[test]
fn every_transition_is_published() {
    let core = UpdaterCore::new(RAW, true, NOW);
    let mut receiver = core.subscribe();
    receiver.mark_unchanged();
    core.on_checking(NOW);
    assert!(receiver.has_changed().unwrap());
    assert_eq!(receiver.borrow_and_update().status, UpdaterStatus::Checking);
    core.on_up_to_date(NOW);
    assert!(receiver.has_changed().unwrap());
    assert_eq!(receiver.borrow_and_update().status, UpdaterStatus::UpToDate);
}
