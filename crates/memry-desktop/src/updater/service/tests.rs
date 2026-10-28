use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::*;
use crate::telemetry::service::{Context, Sender};
use crate::updater::marker::{self, Installer, UPDATE_INSTALL_MARKER_FILENAME};
use crate::updater::scripted::{ApplyCall, ScriptStep, ScriptedBackend, ScriptedFailure};
use crate::updater::state::UpdaterStatus;

mod install;

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
    let backend = Arc::new(ScriptedBackend::new(dir.path().to_owned(), Duration::ZERO));
    let chosen = supported.then(|| backend.clone() as Arc<dyn UpdateBackend>);
    rig_in(dir, config_json, backend, chosen)
}

fn rig_in(
    dir: tempfile::TempDir,
    config_json: Option<&[u8]>,
    backend: Arc<ScriptedBackend>,
    chosen: Option<Arc<dyn UpdateBackend>>,
) -> Rig {
    let config_path = dir.path().join("memry-config.json");
    if let Some(json) = config_json {
        std::fs::write(&config_path, json).unwrap();
    }
    let config = Arc::new(AppConfig::load(config_path));
    let telemetry = telemetry(dir.path());
    let service = UpdaterService::new(UpdaterDeps {
        raw_version: RAW.into(),
        backend: chosen,
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

/// The scripted backend, with a check that can be held open and an apply that records whether
/// the install marker was already on disk.
struct Probe {
    inner: Arc<ScriptedBackend>,
    marker: std::path::PathBuf,
    hold: Mutex<Option<std::sync::mpsc::Receiver<()>>>,
    entered: Mutex<Option<std::sync::mpsc::Sender<()>>>,
    hold_download: Mutex<Option<std::sync::mpsc::Receiver<()>>>,
    marker_at_apply: Mutex<Vec<bool>>,
}

impl UpdateBackend for Probe {
    fn check(&self) -> Result<CheckOutcome, UpdateError> {
        let held = self.hold.lock().unwrap().take();
        if let Some(release) = held {
            if let Some(entered) = self.entered.lock().unwrap().take() {
                entered.send(()).unwrap();
            }
            release.recv().unwrap();
        }
        self.inner.check()
    }
    fn downloaded(&self) -> Option<AvailableUpdate> {
        self.inner.downloaded()
    }
    fn download(&self, progress: &dyn Fn(f64)) -> Result<(), UpdateError> {
        let held = self.hold_download.lock().unwrap().take();
        if let Some(release) = held {
            progress(10.0);
            if let Some(entered) = self.entered.lock().unwrap().take() {
                entered.send(()).unwrap();
            }
            release.recv().unwrap();
        }
        self.inner.download(progress)
    }
    fn apply(&self, silent: bool, restart: bool) -> Result<(), UpdateError> {
        self.marker_at_apply
            .lock()
            .unwrap()
            .push(self.marker.exists());
        self.inner.apply(silent, restart)
    }
    fn installer(&self) -> Installer {
        self.inner.installer()
    }
}

fn probe_rig() -> (Rig, Arc<Probe>) {
    let dir = tempfile::tempdir().unwrap();
    let inner = Arc::new(ScriptedBackend::new(dir.path().to_owned(), Duration::ZERO));
    let probe = Arc::new(Probe {
        inner: inner.clone(),
        marker: dir.path().join(UPDATE_INSTALL_MARKER_FILENAME),
        hold: Mutex::new(None),
        entered: Mutex::new(None),
        hold_download: Mutex::new(None),
        marker_at_apply: Mutex::new(Vec::new()),
    });
    let rig = rig_in(dir, None, inner, Some(probe.clone()));
    (rig, probe)
}

#[tokio::test]
async fn the_install_marker_is_on_disk_before_the_installer_starts() {
    let (rig, probe) = probe_rig();
    downloaded(&rig).await;
    rig.service.request_install().unwrap();
    rig.service.apply_and_restart();
    assert_eq!(*probe.marker_at_apply.lock().unwrap(), [true]);
}

#[tokio::test]
async fn a_routine_check_keeps_a_downloaded_update_downloaded() {
    let rig = rig();
    downloaded(&rig).await;
    // The feed still offers the release already on disk.
    rig.backend.script(vec![available("2026.1101.1")]);
    assert_eq!(
        rig.service.check(false).await.unwrap().status,
        UpdaterStatus::Downloaded
    );
    // A failed check reports, and the download stays ready to install.
    rig.backend.script(vec![ScriptStep::Fail {
        error: ScriptedFailure::Offline,
    }]);
    rig.service.check(false).await.unwrap_err();
    let state = rig.service.state();
    assert_eq!(state.status, UpdaterStatus::Downloaded);
    assert_eq!(state.available_version.as_deref(), Some("v2026-11-01"));
    // So a normal quit still installs it.
    rig.service.apply_on_quit();
    assert_eq!(rig.backend.applies().len(), 1);
}

#[tokio::test]
async fn a_newer_release_replaces_a_downloaded_one() {
    let rig = rig();
    downloaded(&rig).await;
    rig.backend.script(vec![available("2026.1102.1")]);
    let state = rig.service.check(false).await.unwrap();
    assert_eq!(state.status, UpdaterStatus::Available);
    assert_eq!(state.available_version.as_deref(), Some("v2026-11-02"));
}

#[tokio::test]
async fn once_restart_to_install_is_requested_no_check_or_download_runs() {
    let rig = rig();
    downloaded(&rig).await;
    rig.service.request_install().unwrap();
    rig.backend.script(vec![available("2026.1102.1")]);
    assert_eq!(
        rig.service.check(true).await.unwrap().status,
        UpdaterStatus::Installing
    );
    assert_eq!(
        rig.service.download().await.unwrap().status,
        UpdaterStatus::Installing
    );
    // The scripted step is still queued: the feed was never read.
    assert!(matches!(
        rig.backend.check(),
        Ok(CheckOutcome::Available(_))
    ));
}

#[tokio::test]
async fn a_check_in_flight_when_install_starts_leaves_the_installing_screen() {
    let (rig, probe) = probe_rig();
    downloaded(&rig).await;
    let (release, held) = std::sync::mpsc::channel();
    let (entered_tx, entered) = std::sync::mpsc::channel();
    *probe.hold.lock().unwrap() = Some(held);
    *probe.entered.lock().unwrap() = Some(entered_tx);
    rig.backend.script(vec![available("2026.1102.1")]);
    let service = rig.service.clone();
    let check = tokio::spawn(async move { service.check(false).await });
    tokio::task::spawn_blocking(move || entered.recv().unwrap())
        .await
        .unwrap();
    rig.service.request_install().unwrap();
    release.send(()).unwrap();
    check.await.unwrap().unwrap();
    assert_eq!(rig.service.state().status, UpdaterStatus::Installing);
}

#[tokio::test]
async fn a_shutdown_stops_checks_and_downloads() {
    let rig = rig();
    rig.service.stop();
    rig.backend.script(vec![available("2026.1101.1")]);
    assert_eq!(
        rig.service.check(true).await.unwrap().status,
        UpdaterStatus::Idle
    );
    assert!(matches!(
        rig.backend.check(),
        Ok(CheckOutcome::Available(_))
    ));
}

#[tokio::test(start_paused = true)]
async fn the_timer_checks_every_four_hours_until_install_starts() {
    let rig = rig();
    let mut states = rig.service.subscribe();
    rig.service.init();
    // The startup check finds nothing.
    states
        .wait_for(|s| s.status == UpdaterStatus::UpToDate)
        .await
        .unwrap();
    let started = tokio::time::Instant::now();
    rig.backend.script(vec![available("2026.1101.1")]);
    states
        .wait_for(|s| s.status == UpdaterStatus::Available)
        .await
        .unwrap();
    assert!(started.elapsed() >= AUTO_CHECK_INTERVAL);

    rig.service.download().await.unwrap();
    rig.service.request_install().unwrap();
    rig.backend.script(vec![available("2026.1102.1")]);
    // Several intervals pass: the timer is gone, the queued step stays queued.
    tokio::time::sleep(AUTO_CHECK_INTERVAL * 3).await;
    assert_eq!(rig.service.state().status, UpdaterStatus::Installing);
    assert!(matches!(
        rig.backend.check(),
        Ok(CheckOutcome::Available(_))
    ));
}

#[tokio::test]
async fn a_download_in_flight_when_the_quit_begins_changes_nothing() {
    let (rig, probe) = probe_rig();
    rig.backend.script(vec![available("2026.1101.1")]);
    rig.service.check(false).await.unwrap();
    let (release, held) = std::sync::mpsc::channel();
    let (entered_tx, entered) = std::sync::mpsc::channel();
    *probe.hold_download.lock().unwrap() = Some(held);
    *probe.entered.lock().unwrap() = Some(entered_tx);
    let service = rig.service.clone();
    let download = tokio::spawn(async move { service.download().await });
    tokio::task::spawn_blocking(move || entered.recv().unwrap())
        .await
        .unwrap();
    let mut states = rig.service.subscribe();
    states.borrow_and_update();
    rig.service.stop();
    release.send(()).unwrap();
    download.await.unwrap().unwrap();
    // Neither the remaining progress ticks nor the finished download reached a window.
    assert!(!states.has_changed().unwrap());
    assert_eq!(rig.service.state().status, UpdaterStatus::Downloading);
    // A quit that is not Restart to install does not install what landed after it began.
    rig.service.apply_on_quit();
    assert!(rig.backend.applies().is_empty());
}
