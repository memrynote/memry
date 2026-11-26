//! The Readwise page's operations (`readwise::connection`, Electron's `connection.ts`) over the
//! scheduler rig of `readwise_run_schedule.rs`: a real vault, the local Readwise stand-in and
//! the one-row sync fake.
//!
//! | Test                                                                | Electron                      |
//! | ------------------------------------------------------------------- | ----------------------------- |
//! | Sync now from an async command runs and does not panic              | `syncReadwiseNow`             |
//! | the status after an import; a disconnect frees this device's claim  | `getReadwiseStatus`, `disconnectReadwise` |
//! | another device's claim: shown, kept on disconnect, connect refused  | `connection.ts:93-97`, `:168` |
//! | options write leaves; a manual cadence has no next run              | `writeReadwiseOptions`, `nextRunAt` |
//! | the error toast is claimed once per parked episode                  | `claimErrorToast`             |

use memry_desktop::readwise::claim::{Claim, write_claim};
use memry_desktop::readwise::connection::{
    ConnectFailure, OptionsError, ReadwiseCadence, ReadwiseCategoriesInput, ReadwiseOptionsInput,
    ReadwiseRunErrorKind,
};
use memry_desktop::readwise::run_state::{LastRun, RunState};

use super::gate::settings;
use super::schedule::{HOUR_MS, T0, rig};
use super::*;

/// VERIFY-5252: a run blocks on the library runtime, so Sync now called on a runtime worker
/// (an async Tauri command) would panic in `block_on`.
#[test]
fn a_sync_now_from_an_async_command_runs_and_does_not_panic() {
    let r = rig("dev-a", Box::new(|| false));
    let runs = r.service();
    let async_runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    let outcome = async_runtime.block_on(async move { runs.sync_now_async().await });
    outcome.expect("the first import");
    assert_eq!(r.files(), 2);
}

#[test]
fn the_status_shows_the_import_and_a_disconnect_frees_the_claim_this_device_holds() {
    let r = rig("dev-a", Box::new(|| false));
    let runs = r.service();
    let before = runs.status_view().unwrap();
    assert!(before.connected && !before.has_imported && before.this_device_pulls);
    assert_eq!(
        before.next_run_at, None,
        "nothing scheduled before the first import"
    );

    runs.sync_now().expect("the first import");
    let after = runs.status_view().unwrap();
    assert!(after.has_imported && after.last_sync_at.is_some() && after.error.is_none());
    assert_eq!(after.last_run.map(|c| c.books), Some(2));
    let next = DateTime::parse_from_rfc3339(after.next_run_at.as_deref().unwrap()).unwrap();
    assert_eq!(next.timestamp_millis(), T0 + HOUR_MS);
    let store = runs.library().store();
    assert_eq!(
        Claim::read(&store).unwrap().device_id.as_deref(),
        Some("dev-a")
    );

    runs.disconnect().unwrap();
    assert!(!r.has_token());
    let gone = runs.status_view().unwrap();
    assert!(!gone.connected && !gone.has_imported && gone.last_run.is_none());
    assert_eq!(
        Claim::read(&store).unwrap(),
        Claim::default(),
        "the claim is freed"
    );
    assert_eq!(r.files(), 2, "every note stays");
}

#[test]
fn another_devices_claim_is_shown_kept_on_disconnect_and_refuses_a_connect() {
    let r = rig("dev-a", Box::new(|| false));
    let runs = r.service();
    write_claim(&settings(&r.v), "dev-b", Some("Laptop")).unwrap();
    let status = runs.status_view().unwrap();
    assert!(!status.this_device_pulls);
    assert_eq!(status.pulling_device_name.as_deref(), Some("Laptop"));
    assert_eq!(status.next_run_at, None);

    let connect =
        r.v.library
            .runtime
            .block_on(runs.connect("token".to_owned()));
    assert!(
        matches!(connect, Err(ConnectFailure::Elsewhere(Some(ref name))) if name == "Laptop"),
        "{connect:?}"
    );

    runs.disconnect().unwrap();
    let claim = Claim::read(&runs.library().store()).unwrap();
    assert_eq!(
        claim.device_id.as_deref(),
        Some("dev-b"),
        "only the holder frees it"
    );
}

#[test]
fn options_write_one_leaf_each_and_a_manual_cadence_has_no_next_run() {
    let r = rig("dev-a", Box::new(|| false));
    let runs = r.service();
    runs.sync_now().expect("the first import");
    let input = ReadwiseOptionsInput {
        root_folder: Some(" /Library/Readwise/ ".to_owned()),
        cadence: Some(ReadwiseCadence::Manual),
        categories: Some(ReadwiseCategoriesInput {
            supplementals: Some(true),
            ..ReadwiseCategoriesInput::default()
        }),
        ..ReadwiseOptionsInput::default()
    };
    runs.set_options(&input).unwrap();
    let status = runs.status_view().unwrap();
    assert_eq!(status.options.root_folder, "Library/Readwise");
    assert_eq!(status.options.cadence, ReadwiseCadence::Manual);
    assert!(status.options.categories.supplementals && status.options.categories.books);
    assert_eq!(status.next_run_at, None, "manual never schedules");

    let bad = ReadwiseOptionsInput {
        root_folder: Some("a/../b".to_owned()),
        ..ReadwiseOptionsInput::default()
    };
    assert!(matches!(
        runs.set_options(&bad),
        Err(OptionsError::InvalidRoot)
    ));
    let status = runs.status_view().unwrap();
    assert_eq!(
        status.options.root_folder, "Library/Readwise",
        "nothing written"
    );
}

#[test]
fn the_error_toast_is_claimed_once_per_parked_episode() {
    let r = rig("dev-a", Box::new(|| false));
    let runs = r.service();
    assert!(!runs.ack_error_toast().unwrap(), "not parked");
    let state = RunState::new(runs.library().store());
    let park = |needs_attention| LastRun {
        at: "2026-11-20T10:00:00.000Z".to_owned(),
        needs_attention,
        attention: None,
        counts: None,
    };
    state.set_last_run(&park(true)).unwrap();
    let status = runs.status_view().unwrap();
    assert!(status.needs_attention);
    assert_eq!(
        status.error.map(|e| e.kind),
        Some(ReadwiseRunErrorKind::InvalidToken)
    );
    assert!(
        runs.ack_error_toast().unwrap(),
        "the first ask of the episode"
    );
    assert!(!runs.ack_error_toast().unwrap(), "once");

    state.set_last_run(&park(false)).unwrap();
    state.set_last_run(&park(true)).unwrap();
    assert!(
        runs.ack_error_toast().unwrap(),
        "a new episode toasts again"
    );
}
