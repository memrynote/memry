//! Handing a downloaded update to the installer: Restart to install and install on a normal
//! quit, including an update an earlier run left on disk.

use super::*;
use crate::updater::service::install::NotReady;

#[tokio::test]
async fn restart_to_install_needs_a_downloaded_update() {
    let rig = rig();
    assert_eq!(rig.service.request_install(), Err(NotReady));
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
async fn an_update_an_earlier_run_left_on_disk_installs_at_the_next_normal_quit_offline_too() {
    let rig = rig();
    rig.backend.leave_downloaded("2026.1101.1");
    rig.backend.script(vec![ScriptStep::Fail {
        error: ScriptedFailure::Offline,
    }]);
    let mut states = rig.service.subscribe();
    rig.service.init();
    tokio::time::timeout(
        Duration::from_secs(5),
        states.wait_for(|state| state.status == UpdaterStatus::Downloaded),
    )
    .await
    .unwrap()
    .unwrap();
    rig.service.apply_on_quit();
    assert_eq!(
        rig.backend.applies(),
        [ApplyCall {
            silent: true,
            restart: false
        }]
    );
    let detected = marker::detect(rig.dir.path(), RAW, || unreachable!()).unwrap();
    assert_eq!(detected.attempt.to_version.as_deref(), Some("v2026-11-01"));
}

#[tokio::test]
async fn a_skipped_version_left_on_disk_is_not_installed() {
    let rig = rig_with(
        Some(br#"{"updater":{"autoCheck":false,"skippedVersion":"v2026-11-01"}}"#),
        true,
    );
    rig.backend.leave_downloaded("2026.1101.1");
    rig.service.init();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(rig.service.state().status, UpdaterStatus::Idle);
    rig.service.apply_on_quit();
    assert!(rig.backend.applies().is_empty());
}

#[tokio::test]
async fn nothing_installs_on_quit_without_a_downloaded_update() {
    let rig = rig();
    rig.backend.script(vec![available("2026.1101.1")]);
    rig.service.check(false).await.unwrap();
    rig.service.apply_on_quit();
    assert!(rig.backend.applies().is_empty());
}
