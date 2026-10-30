use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use memry_tauri::commands::error::{CommandError, ErrorKind};
use memry_tauri::startup::{Stage, Stages, StartupState, script};
use tauri::AppHandle;
use tauri::test::{MockRuntime, mock_app};

static ORDER: Mutex<Vec<&'static str>> = Mutex::new(Vec::new());
// The tests share `ORDER`, so they take turns.
static TURN: Mutex<()> = Mutex::new(());

fn record(name: &'static str) {
    ORDER.lock().expect("lock").push(name);
}

fn a(_: &AppHandle<MockRuntime>) -> Result<(), CommandError> {
    record("window-a");
    Ok(())
}
fn b(_: &AppHandle<MockRuntime>) -> Result<(), CommandError> {
    record("paths");
    Ok(())
}
fn c(_: &AppHandle<MockRuntime>) -> Result<(), CommandError> {
    record("window-b");
    Ok(())
}
fn d(_: &AppHandle<MockRuntime>) -> Result<(), CommandError> {
    record("schedulers");
    Ok(())
}
fn failing(_: &AppHandle<MockRuntime>) -> Result<(), CommandError> {
    Err(CommandError::new(
        ErrorKind::Internal,
        "boom",
        "stage failed",
    ))
}

#[test]
fn startup_stages_run_in_enum_order_then_registration_order() {
    let _turn = TURN
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let app = mock_app();
    let mut stages = Stages::<MockRuntime>::default();
    stages.register(Stage::Window, "a", a);
    stages.register(Stage::Paths, "b", b);
    stages.register(Stage::Window, "c", c);
    stages.register(Stage::Schedulers, "d", d);
    ORDER.lock().expect("lock").clear();

    stages
        .run(app.handle(), || false, || false)
        .expect("all stages pass");

    assert_eq!(
        ORDER.lock().expect("lock").as_slice(),
        ["paths", "window-a", "window-b", "schedulers"]
    );
}

#[test]
fn startup_skips_schedulers_once_shutdown_started() {
    let _turn = TURN
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let app = mock_app();
    let mut stages = Stages::<MockRuntime>::default();
    stages.register(Stage::Paths, "b", b);
    stages.register(Stage::Schedulers, "d", d);
    ORDER.lock().expect("lock").clear();

    stages
        .run(app.handle(), || true, || false)
        .expect("stages pass");

    assert_eq!(ORDER.lock().expect("lock").as_slice(), ["paths"]);
}

#[test]
fn startup_failure_names_the_stage_and_stops_later_stages() {
    let _turn = TURN
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let app = mock_app();
    let mut stages = Stages::<MockRuntime>::default();
    stages.register(Stage::Logging, "failing stage", failing);
    stages.register(Stage::Window, "a", a);
    ORDER.lock().expect("lock").clear();

    let failure = stages
        .run(app.handle(), || false, || false)
        .expect_err("a stage fails");

    assert_eq!(failure.stage, Stage::Logging);
    assert_eq!(failure.name, "failing stage");
    assert_eq!(failure.error.code, "boom");
    assert!(ORDER.lock().expect("lock").is_empty());
}

fn halting(_: &AppHandle<MockRuntime>) -> Result<(), CommandError> {
    record("relaunch guard");
    HALTED.store(true, Ordering::SeqCst);
    Ok(())
}

static HALTED: AtomicBool = AtomicBool::new(false);

/// The macOS relaunch guard ends the boot in its stage: the crash monitor registered after it in
/// the same stage would start a child of the old bundle, and the window would boot the old build.
#[test]
fn nothing_runs_after_a_registration_halts_the_boot() {
    let _turn = TURN
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let app = mock_app();
    let mut stages = Stages::<MockRuntime>::default();
    stages.register(Stage::Window, "a", a);
    stages.register(Stage::Guards, "relaunch guard", halting);
    stages.register(Stage::Guards, "b", b);
    ORDER.lock().expect("lock").clear();

    stages
        .run(app.handle(), || false, || HALTED.load(Ordering::SeqCst))
        .expect("a halt is not a failure");

    assert_eq!(ORDER.lock().expect("lock").as_slice(), ["relaunch guard"]);
}

#[test]
fn startup_script_freezes_the_state_and_never_closes_a_script_tag() {
    let state = StartupState {
        theme: "dark".to_owned(),
        startup_vault: Some("</script><b>".to_owned()),
        ..StartupState::default()
    };

    let js = script(&state);

    assert!(js.starts_with("window.__MEMRY_STARTUP__ = Object.freeze({"));
    assert!(js.ends_with("});"));
    assert!(!js.contains("</script"), "script was: {js}");
    assert!(js.contains(r#""theme":"dark""#));
    assert!(js.contains(r#""startupVault":"\u003c/script>\u003cb>""#));
}

#[test]
fn startup_defaults_are_the_electron_fallbacks() {
    let state = StartupState::default();
    assert_eq!(state.theme, "system");
    assert_eq!(state.locale, "en");
    assert_eq!(state.zoom, 1.0);
    assert!(["darwin", "win32", "linux"].contains(&state.platform.as_str()));
    assert!(state.color_theme.is_none() && state.startup_vault.is_none());
}

#[test]
fn the_launch_checks_webview2_after_the_relaunch_guard_and_before_any_other_guard() {
    let names: Vec<_> = memry_tauri::guards::guards()
        .into_iter()
        .map(|(name, _)| name)
        .collect();
    let expected: &[&str] = if cfg!(windows) {
        &["updater relaunch guard", "check webview2 runtime"]
    } else {
        &["updater relaunch guard"]
    };
    assert_eq!(&names[..expected.len()], expected);
    assert_eq!(
        names
            .iter()
            .filter(|name| **name == "check webview2 runtime")
            .count(),
        usize::from(cfg!(windows))
    );
}
