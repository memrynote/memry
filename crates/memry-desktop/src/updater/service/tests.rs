use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use super::*;
use crate::telemetry::service::{Context, Sender};
use crate::updater::marker;
use crate::updater::scripted::{ApplyCall, ScriptStep, ScriptedBackend, ScriptedFailure};
use crate::updater::state::UpdaterStatus;

const RAW: &str = "2026.1015.1";

struct Rig {
    service: Arc<UpdaterService>,
    backend: Arc<ScriptedBackend>,
    telemetry: Arc<Telemetry>,
    config: Arc<AppConfig>,
    dir: tempfile::TempDir,
}

fn telemetry(dir: &Path) -> Arc<Telemetry> {
    let context = Context {
        install_id: "i".into(),
        session_id: "s".into(),
        app_version: RAW.into(),
        build_channel: "production".into(),
        platform: "darwin".into(),
        arch: "arm64".into(),
        locale: "en".into(),
        timezone_offset_minutes: 0,
    };
    Arc::new(Telemetry::start(
        dir,
        context,
        Sender::new("http://127.0.0.1:1/x"),
        true,
    ))
}

fn rig_with(config_json: Option<&[u8]>, supported: bool) -> Rig {
    let dir = tempfile::tempdir().unwrap();
    let config_path = dir.path().join("memry-config.json");
    if let Some(json) = config_json {
        std::fs::write(&config_path, json).unwrap();
    }
    let config = Arc::new(AppConfig::load(config_path));
    let backend = Arc::new(ScriptedBackend::new(dir.path().to_owned(), Duration::ZERO));
    let telemetry = telemetry(dir.path());
    let service = UpdaterService::new(UpdaterDeps {
        raw_version: RAW.into(),
        backend: supported.then(|| backend.clone() as Arc<dyn UpdateBackend>),
        config: config.clone(),
        data_dir: dir.path().to_owned(),
        telemetry: Some(telemetry.clone()),
        locale: Arc::new(LocaleService::new("en")),
        outside_applications: true,
        runtime: Handle::current(),
    });
    Rig {
        service,
        backend,
        telemetry,
        config,
        dir,
    }
}

fn rig() -> Rig {
    rig_with(None, true)
}

fn available(version: &str) -> ScriptStep {
    ScriptStep::Available {
        version: version.into(),
        notes_html: Some("<h2>Fixes</h2><ul><li>Sync</li></ul><h2>Changelog</h2><p>x</p>".into()),
    }
}

fn names(telemetry: &Telemetry) -> Vec<(String, String)> {
    telemetry
        .queued()
        .into_iter()
        .map(|event| (event.name, event.action))
        .collect()
}

#[tokio::test]
async fn without_a_backend_the_updater_is_unavailable_and_does_nothing() {
    let rig = rig_with(None, false);
    rig.service.init();
    let state = rig.service.check(true).await.unwrap();
    assert_eq!(state.status, UpdaterStatus::Unavailable);
    assert!(!state.update_supported);
    assert_eq!(
        rig.service.download().await.unwrap().status,
        UpdaterStatus::Unavailable
    );
}

#[tokio::test]
async fn a_check_offers_the_release_with_plain_notes_and_the_full_html() {
    let rig = rig();
    rig.backend.script(vec![available("2026.1101.1")]);
    let state = rig.service.check(true).await.unwrap();
    assert_eq!(state.status, UpdaterStatus::Available);
    assert_eq!(state.available_version.as_deref(), Some("v2026-11-01"));
    assert_eq!(state.release_notes.as_deref(), Some("Fixes\n• Sync"));
    assert!(state.release_notes_html.unwrap().contains("Changelog"));
    assert!(state.last_checked_at.is_some());
}

#[tokio::test]
async fn concurrent_checks_share_one_feed_read() {
    let rig = rig();
    rig.backend
        .script(vec![available("2026.1101.1"), available("2026.1102.1")]);
    let (a, b) = tokio::join!(rig.service.check(false), rig.service.check(false));
    assert_eq!(a.unwrap(), b.unwrap());
    // The second step is still queued: one check ran.
    let next = rig.service.check(false).await.unwrap();
    assert_eq!(next.available_version.as_deref(), Some("v2026-11-02"));
}

#[tokio::test]
async fn a_skipped_version_stays_hidden_until_a_manual_check() {
    let rig = rig();
    rig.backend.script(vec![available("2026.1101.1")]);
    rig.service.check(false).await.unwrap();
    let state = rig.service.skip_version("v2026-11-01").unwrap();
    assert_eq!(state.status, UpdaterStatus::UpToDate);
    assert_eq!(
        rig.config.updater().skipped_version.as_deref(),
        Some("v2026-11-01")
    );

    rig.backend.script(vec![available("2026.1101.1")]);
    assert_eq!(
        rig.service.check(false).await.unwrap().status,
        UpdaterStatus::UpToDate
    );
    rig.backend.script(vec![available("2026.1101.1")]);
    assert_eq!(
        rig.service.check(true).await.unwrap().status,
        UpdaterStatus::Available
    );
    assert_eq!(rig.config.updater().skipped_version, None);
    assert!(names(&rig.telemetry).contains(&("setting_changed".into(), "changed".into())));
}

#[tokio::test]
async fn a_download_moves_through_progress_to_downloaded_and_is_not_repeated() {
    let rig = rig();
    rig.backend.script(vec![available("2026.1101.1")]);
    rig.service.check(false).await.unwrap();
    let mut states = rig.service.subscribe();
    let state = rig.service.download().await.unwrap();
    assert_eq!(state.status, UpdaterStatus::Downloaded);
    assert_eq!(state.download_progress_percent, Some(100));
    assert!(states.has_changed().unwrap());
    assert_eq!(states.borrow_and_update().status, UpdaterStatus::Downloaded);
    assert_eq!(
        rig.service.download().await.unwrap().status,
        UpdaterStatus::Downloaded
    );
}

#[tokio::test]
async fn auto_download_starts_the_download_when_the_check_finds_a_release() {
    let rig = rig();
    rig.service.set_auto_download(true).unwrap();
    rig.backend.script(vec![available("2026.1101.1")]);
    rig.service.check(false).await.unwrap();
    let mut states = rig.service.subscribe();
    tokio::time::timeout(
        Duration::from_secs(5),
        states.wait_for(|s| s.status == UpdaterStatus::Downloaded),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(rig.config.updater().auto_download);
}

#[tokio::test]
async fn turning_auto_download_on_downloads_a_waiting_update() {
    let rig = rig();
    rig.backend.script(vec![available("2026.1101.1")]);
    rig.service.check(false).await.unwrap();
    rig.service.set_auto_download(true).unwrap();
    let mut states = rig.service.subscribe();
    tokio::time::timeout(
        Duration::from_secs(5),
        states.wait_for(|s| s.status == UpdaterStatus::Downloaded),
    )
    .await
    .unwrap()
    .unwrap();
}

#[tokio::test]
async fn an_offline_check_is_a_warning_and_a_missing_feed_an_error() {
    let rig = rig();
    rig.backend.script(vec![ScriptStep::Fail {
        error: ScriptedFailure::Offline,
    }]);
    let error = rig.service.check(false).await.unwrap_err();
    assert!(matches!(error.kind, UpdateErrorKind::Network(_)));
    let state = rig.service.state();
    assert_eq!(state.status, UpdaterStatus::Error);
    assert_eq!(state.error.as_deref(), Some(error.message.as_str()));
    let queued = rig.telemetry.queued();
    assert_eq!(queued.len(), 1);
    assert_eq!(
        (queued[0].name.as_str(), queued[0].action.as_str()),
        ("app_log_recorded", "warn")
    );
    assert_eq!(queued[0].metrics.as_ref().unwrap().retry_count, Some(1.0));

    rig.backend.script(vec![ScriptStep::Fail {
        error: ScriptedFailure::NotFound,
    }]);
    rig.service.check(false).await.unwrap_err();
    let last = rig.telemetry.queued().pop().unwrap();
    assert_eq!(
        (last.name.as_str(), last.error_code.as_deref()),
        ("app_error_seen", Some("HTTP_ERROR_404"))
    );
}

#[tokio::test]
async fn reads_the_preferences_electron_wrote_and_keeps_its_other_keys() {
    let electron = include_bytes!("../../../tests/fixtures/electron/updater/memry-config.json");
    let rig = rig_with(Some(electron), true);
    rig.service.init();
    let state = rig.service.state();
    assert!(state.auto_download_enabled);
    assert!(!state.auto_check_enabled);
    // Auto check is off: init neither checked nor armed the timer.
    assert_eq!(state.status, UpdaterStatus::Idle);

    rig.backend.script(vec![available("2026.1020.1")]);
    assert_eq!(
        rig.service.check(false).await.unwrap().status,
        UpdaterStatus::UpToDate
    );
    rig.service.set_auto_check(true).unwrap();
    let written: serde_json::Value =
        serde_json::from_slice(&std::fs::read(rig.dir.path().join("memry-config.json")).unwrap())
            .unwrap();
    assert_eq!(
        written["updater"],
        serde_json::json!({"autoDownload": true, "autoCheck": true, "skippedVersion": "v2026-10-20"})
    );
    assert_eq!(written["captureAllowedOrigins"], serde_json::json!([]));
    assert_eq!(written["crdtStore"], serde_json::json!({}));
}

#[tokio::test]
async fn init_resurfaces_an_escalated_install_streak() {
    let rig = rig();
    for _ in 0..3 {
        health::record_failure(rig.dir.path(), "v2026-10-15", "v2026-11-01");
    }
    rig.service.init();
    assert_eq!(
        rig.service
            .state()
            .install_failed
            .and_then(|f| f.version)
            .as_deref(),
        Some("v2026-11-01")
    );
}

async fn downloaded(rig: &Rig) {
    rig.backend.script(vec![available("2026.1101.1")]);
    rig.service.check(false).await.unwrap();
    rig.service.download().await.unwrap();
}

#[tokio::test]
async fn restart_to_install_needs_a_downloaded_update() {
    let rig = rig();
    assert_eq!(rig.service.request_install(), Err(install::NotReady));
    assert!(!rig.service.install_requested());
}

#[tokio::test]
async fn restart_to_install_shows_installing_and_hands_off_once_with_a_marker() {
    let rig = rig();
    downloaded(&rig).await;
    rig.service.request_install().unwrap();
    assert_eq!(rig.service.state().status, UpdaterStatus::Installing);
    assert!(rig.service.install_requested());
    assert!(rig.service.apply_and_restart());
    assert!(!rig.service.apply_and_restart());
    rig.service.apply_on_quit();
    assert_eq!(
        rig.backend.applies(),
        [ApplyCall {
            silent: true,
            restart: true
        }]
    );
    let detected = marker::detect(rig.dir.path(), RAW, || unreachable!()).unwrap();
    assert_eq!(detected.attempt.to_version.as_deref(), Some("v2026-11-01"));
    assert_eq!(
        detected.attempt.installer,
        Some(marker::Installer::Velopack)
    );
}

#[tokio::test]
async fn a_normal_quit_installs_a_downloaded_update_without_a_relaunch() {
    let rig = rig();
    downloaded(&rig).await;
    rig.service.apply_on_quit();
    rig.service.apply_on_quit();
    assert_eq!(
        rig.backend.applies(),
        [ApplyCall {
            silent: true,
            restart: false
        }]
    );
}

#[tokio::test]
async fn a_session_end_skips_install_on_quit_until_it_is_cancelled() {
    let rig = rig();
    downloaded(&rig).await;
    rig.service.disable_install_on_quit();
    rig.service.apply_on_quit();
    assert!(rig.backend.applies().is_empty());
    assert!(
        !rig.dir
            .path()
            .join(marker::UPDATE_INSTALL_MARKER_FILENAME)
            .exists()
    );

    rig.service.enable_install_on_quit();
    rig.service.apply_on_quit();
    assert_eq!(rig.backend.applies().len(), 1);
}

#[tokio::test]
async fn nothing_installs_on_quit_without_a_downloaded_update() {
    let rig = rig();
    rig.backend.script(vec![available("2026.1101.1")]);
    rig.service.check(false).await.unwrap();
    rig.service.apply_on_quit();
    assert!(rig.backend.applies().is_empty());
}
