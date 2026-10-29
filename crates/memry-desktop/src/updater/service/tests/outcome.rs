//! The previous run's install, as the next launch reports it.

use super::*;
use crate::telemetry::events::TelemetryEvent;
use crate::updater::marker::{DetectedInstall, UpdateInstallAttempt, UpdateInstallOutcome};
use crate::updater::state::InstallFailed;

/// A Tauri build after Electron's `2026.1015.1`, the version of the Electron fixtures.
const TAURI: &str = "2026.1101.1";

fn rig_at(dir: tempfile::TempDir, version: &str, channel: Option<&str>) -> Rig {
    let backend = Arc::new(ScriptedBackend::new(dir.path().to_owned(), Duration::ZERO));
    let config = Arc::new(AppConfig::load(dir.path().join("memry-config.json")));
    let telemetry = telemetry(dir.path());
    let service = UpdaterService::new(UpdaterDeps {
        raw_version: version.into(),
        channel: channel.map(str::to_owned),
        backend: Some(backend.clone()),
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

fn on_channel(dir: tempfile::TempDir, channel: &str) -> Rig {
    rig_at(dir, RAW, Some(channel))
}

fn errors(telemetry: &Telemetry) -> Vec<TelemetryEvent> {
    telemetry
        .queued()
        .into_iter()
        .filter(|event| event.name == "app_error_seen")
        .collect()
}

fn marker_left(dir: &Path) -> bool {
    dir.join(UPDATE_INSTALL_MARKER_FILENAME).exists()
}

#[tokio::test]
async fn a_build_still_running_after_its_install_offers_the_manual_installer() {
    let rig = rig();
    marker::write_started(
        rig.dir.path(),
        &rig.service.build(),
        Some("v2026-11-01"),
        Some(Installer::Velopack),
        now_ms() - 4_000,
    );
    rig.service.init(None);

    assert_eq!(
        rig.service.state().install_failed,
        Some(InstallFailed {
            version: Some("v2026-11-01".into())
        })
    );
    let errors = errors(&rig.telemetry);
    assert_eq!(errors.len(), 1, "{errors:?}");
    let event = &errors[0];
    assert_eq!(
        (
            event.action.as_str(),
            event.source.as_deref(),
            event.error_code.as_deref()
        ),
        (
            "install",
            Some("velopack"),
            Some("UPDATE_INSTALL_DID_NOT_APPLY")
        )
    );
    assert!(event.metrics.as_ref().unwrap().duration_ms.unwrap() >= 4_000.0);
    assert_eq!(
        event.dimensions.as_ref().unwrap().get("prior_app_version"),
        Some(&RAW.to_owned())
    );
    assert!(!marker_left(rig.dir.path()));
}

/// The Windows ARM64 move installs the same release from the `win-arm64` channel. The x64 build
/// wrote the marker; the arm64 build that reads it is the update having applied.
#[tokio::test]
async fn the_move_to_the_arm64_pack_of_the_same_release_is_not_a_failed_install() {
    let x64 = on_channel(tempfile::tempdir().unwrap(), "win");
    downloaded(&x64).await;
    x64.service.apply_on_quit();
    assert!(marker_left(x64.dir.path()));

    let arm64 = on_channel(x64.dir, "win-arm64");
    arm64.service.init(None);
    assert_eq!(arm64.service.state().install_failed, None);
    assert!(errors(&arm64.telemetry).is_empty());
    assert!(!marker_left(arm64.dir.path()));

    // The same channel on the same version is the install having failed.
    downloaded(&arm64).await;
    arm64.service.apply_on_quit();
    let again = on_channel(arm64.dir, "win-arm64");
    again.service.init(None);
    assert!(again.service.state().install_failed.is_some());
}

/// The last Electron build writes its marker into its own profile before it hands over; the first
/// launch after it reads that one too, and consumes it.
#[tokio::test]
async fn the_marker_the_last_electron_build_left_in_its_profile_is_read_once() {
    let rig = rig_at(tempfile::tempdir().unwrap(), TAURI, Some("osx-arm64"));
    let profile = tempfile::tempdir().unwrap();
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/electron/updater/update-install-attempt.electron-updater.json");
    std::fs::copy(fixture, profile.path().join(UPDATE_INSTALL_MARKER_FILENAME)).unwrap();

    rig.service.init(Some(profile.path()));
    assert_eq!(rig.service.state().install_failed, None);
    assert!(errors(&rig.telemetry).is_empty());
    assert!(!marker_left(profile.path()));
}

#[tokio::test]
async fn reports_each_hand_off_outcome_as_electron_does() {
    let rig = rig();
    let detected = |outcome| DetectedInstall {
        attempt: UpdateInstallAttempt {
            from_version: "2026.1015.1".into(),
            to_version: Some("v2026-11-01".into()),
            started_at: String::new(),
            installer: Some(Installer::VelopackHandoff),
            from_channel: None,
            from_arch: None,
        },
        outcome,
    };
    rig.service
        .report_install(&detected(UpdateInstallOutcome::HandoffApplied));
    rig.service
        .report_install(&detected(UpdateInstallOutcome::HandoffFellBack));
    rig.service
        .report_install(&detected(UpdateInstallOutcome::Applied));

    let reported: Vec<_> = rig
        .telemetry
        .queued()
        .into_iter()
        .map(|event| {
            (
                event.name,
                event.action,
                event.source,
                event.result,
                event.error_code,
                event.dimensions,
            )
        })
        .collect();
    let from = Some([("from_version".to_owned(), "2026.1015.1".to_owned())].into());
    let prior = Some([("prior_app_version".to_owned(), "2026.1015.1".to_owned())].into());
    assert_eq!(
        reported,
        [
            (
                "app_update_installed".to_owned(),
                "migrated".to_owned(),
                Some("velopack-handoff".to_owned()),
                Some("success".to_owned()),
                None,
                from,
            ),
            (
                "app_error_seen".to_owned(),
                "install".to_owned(),
                Some("velopack-handoff".to_owned()),
                Some("failed".to_owned()),
                Some("INSTALLER_HANDOFF_DID_NOT_APPLY".to_owned()),
                prior,
            ),
        ]
    );
    // Only a build that is still the old one leaves the user stranded.
    assert_eq!(rig.service.state().install_failed, None);
}
