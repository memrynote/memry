//! The window gate of the first-launch migration commands (`registry::window_gate`), through
//! the IPC a page calls: the `preboot` window reaches the three commands of its migration view
//! and nothing else, the `startup-error` window reaches no command, and no other window reaches
//! the three.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

use memry_desktop::electron_import::progress::ProgressSink;
use memry_desktop::paths::AppPaths;
use memry_desktop::telemetry::events::TelemetryEvent;
use memry_tauri::binary;
use memry_tauri::instance::window_to_raise;
use memry_tauri::migration::status::{MigrationState, MigrationStatus};
use memry_tauri::migration::{Backend, Migration, MigrationFailure, TelemetrySink};
use memry_tauri::registry::{PREBOOT_COMMANDS, window_allows, window_gate};
use serde_json::Value;
use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
use tauri::test::{
    INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder, mock_context, noop_assets,
};
use tauri::webview::InvokeRequest;
use tauri::{Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_specta::{ErrorHandlingMode, collect_commands};

#[cfg(windows)]
const LOCAL_ORIGIN: &str = "http://tauri.localhost";
#[cfg(not(windows))]
const LOCAL_ORIGIN: &str = "tauri://localhost";

const ALL_COMMANDS: [&str; 4] = [
    "migration_status",
    "migration_retry",
    "migration_open_report",
    "migration_localstorage_applied",
];

/// Fails its first run with `disk-space` and passes every later one.
struct FailOnce(AtomicU32);

impl Backend for FailOnce {
    fn needed(&self) -> bool {
        true
    }

    fn run(
        &self,
        _progress: &dyn ProgressSink,
        _telemetry: &dyn TelemetrySink,
    ) -> Result<(), MigrationFailure> {
        if self.0.fetch_add(1, Ordering::SeqCst) == 0 {
            return Err(MigrationFailure {
                check: "disk-space".to_owned(),
                details: "need 3 GB".to_owned(),
            });
        }
        Ok(())
    }

    fn backup(&self) -> PathBuf {
        PathBuf::new()
    }

    fn take_change_notice(&self) -> bool {
        false
    }
}

struct NoTelemetry;

impl TelemetrySink for NoTelemetry {
    fn record(&self, _event: TelemetryEvent) {}
}

struct Fixture {
    _dir: tempfile::TempDir,
    migration: Arc<Migration>,
    main: WebviewWindow<MockRuntime>,
    preboot: WebviewWindow<MockRuntime>,
    startup_error: WebviewWindow<MockRuntime>,
}

/// A mock app whose migration has failed once, with the three windows.
fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let typed = tauri_specta::Builder::<MockRuntime>::new()
        .error_handling(ErrorHandlingMode::Throw)
        .commands(collect_commands![
            memry_tauri::commands::migration::migration_status::<MockRuntime>,
            memry_tauri::commands::migration::migration_retry::<MockRuntime>,
            memry_tauri::commands::migration::migration_open_report::<MockRuntime>,
            memry_tauri::commands::migration::migration_localstorage_applied::<MockRuntime>,
        ]);
    let app = mock_builder()
        .invoke_handler(window_gate(typed.invoke_handler()))
        .build(mock_context(noop_assets()))
        .unwrap();
    let migration = Arc::new(Migration::new(
        Arc::new(FailOnce(AtomicU32::new(0))),
        "en",
        dir.path(),
        Arc::new(NoTelemetry),
        None,
        Box::new(|| {}),
    ));
    app.manage(migration.clone());
    app.manage(AppPaths {
        data_dir: dir.path().to_path_buf(),
        log_dir: dir.path().to_path_buf(),
    });
    assert!(migration.start());
    wait_for(&migration, MigrationState::Failed);
    let window = |label| {
        WebviewWindowBuilder::new(&app, label, WebviewUrl::default())
            .build()
            .unwrap()
    };
    let (main, preboot, startup_error) =
        (window("main"), window("preboot"), window("startup-error"));
    std::mem::forget(app);
    Fixture {
        _dir: dir,
        migration,
        main,
        preboot,
        startup_error,
    }
}

fn wait_for(migration: &Migration, state: MigrationState) {
    let deadline = Instant::now() + Duration::from_secs(25);
    while migration.status().state != state {
        assert!(Instant::now() < deadline, "no {state:?} status");
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn invoke(window: &WebviewWindow<MockRuntime>, cmd: &str) -> Result<InvokeResponseBody, Value> {
    get_ipc_response(
        window,
        InvokeRequest {
            cmd: cmd.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: LOCAL_ORIGIN.parse().unwrap(),
            body: InvokeBody::default(),
            headers: tauri::http::HeaderMap::new(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
}

fn refused(window: &WebviewWindow<MockRuntime>, cmd: &str) -> bool {
    matches!(invoke(window, cmd), Err(error) if error["code"] == "window_not_allowed")
}

#[test]
fn the_preboot_window_reaches_its_three_commands_and_nothing_else() {
    let fixture = fixture();

    let status: MigrationStatus = invoke(&fixture.preboot, "migration_status")
        .unwrap()
        .deserialize()
        .unwrap();
    assert_eq!(status.check.as_deref(), Some("disk-space"));
    let missing = invoke(&fixture.preboot, "migration_open_report").unwrap_err();
    assert_eq!(missing["code"], "migration_report_missing");
    assert!(refused(&fixture.preboot, "migration_localstorage_applied"));

    invoke(&fixture.preboot, "migration_retry").unwrap();
    wait_for(&fixture.migration, MigrationState::Done);
}

#[test]
fn no_other_window_reaches_the_preboot_commands() {
    let fixture = fixture();

    for command in PREBOOT_COMMANDS {
        assert!(refused(&fixture.main, command), "main: {command}");
    }
    assert_eq!(
        fixture.migration.status().state,
        MigrationState::Failed,
        "a refused Try again starts no run"
    );
    assert!(!refused(&fixture.main, "migration_localstorage_applied"));
}

#[test]
fn the_startup_error_window_reaches_no_command() {
    let fixture = fixture();

    for command in ALL_COMMANDS {
        assert!(refused(&fixture.startup_error, command), "{command}");
    }
    assert_eq!(fixture.migration.status().state, MigrationState::Failed);
}

/// The boot waits in the migration stage, before any vault opens and before the main window
/// exists, so no sign-in, token refresh or vault open may run before the import marker does
/// (#5140). Every command the app registers is refused to the preboot window but the three of
/// its view.
#[test]
fn the_preboot_window_reaches_no_sign_in_token_or_vault_command() {
    let registry = include_str!("../src/registry.rs");
    let mut commands: Vec<&str> = registry
        .lines()
        .filter_map(|line| line.trim().strip_prefix("crate::commands::"))
        .filter_map(|path| {
            path.split("::<")
                .next()?
                .trim_end_matches(',')
                .rsplit("::")
                .next()
        })
        .chain(binary::COMMANDS.iter().copied())
        .collect();
    commands.sort_unstable();
    commands.dedup();
    for command in [
        "auth_refresh_token",
        "auth_request_otp",
        "auth_verify_otp",
        "auth_init_oauth",
        "sync_link_via_recovery",
        "vault_select",
        "vault_switch",
        "vault_create",
    ] {
        assert!(commands.contains(&command), "{command} is registered");
    }
    assert!(commands.len() > 300, "{} commands read", commands.len());

    let reachable: Vec<&str> = commands
        .iter()
        .copied()
        .filter(|command| window_allows("preboot", command))
        .collect();
    let mut expected = PREBOOT_COMMANDS.to_vec();
    expected.sort_unstable();
    assert_eq!(reachable, expected);
    assert!(
        commands
            .iter()
            .all(|command| !window_allows("startup-error", command))
    );
}

/// A second launch while the boot waits for the migration brings the migration window forward:
/// the main window does not exist yet. A startup-error window still comes first.
#[test]
fn a_second_launch_brings_the_migration_window_forward() {
    let app = mock_builder().build(mock_context(noop_assets())).unwrap();
    let raised = || window_to_raise(app.handle()).map(|window| window.label().to_owned());
    let window = |label| {
        WebviewWindowBuilder::new(&app, label, WebviewUrl::default())
            .build()
            .unwrap()
    };
    assert_eq!(raised(), None, "the main window path");
    let _preboot = window("preboot");
    assert_eq!(raised().as_deref(), Some("preboot"));
    let _startup_error = window("startup-error");
    assert_eq!(raised().as_deref(), Some("startup-error"));
    std::mem::forget(app);
}
