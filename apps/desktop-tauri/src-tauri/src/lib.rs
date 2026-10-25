//! MemryNote desktop shell. `run()` owns the boot sequence; domain steps register startup work
//! with `startup::register` and commands in `registry.rs`.

pub mod binary;
pub mod commands;
#[cfg(feature = "e2e")]
pub mod e2e;
pub mod events;
pub mod registry;
pub mod startup;
pub mod windows;

use memry_desktop::launch_env::LaunchEnv;
use memry_desktop::logging::{self, LogGuard};
use memry_desktop::paths::AppPaths;
use tauri::{AppHandle, Manager, Wry};

use crate::commands::app::BuildKind;
use crate::commands::error::{CommandError, ErrorKind};
use crate::startup::{Stage, StartupState};

/// Process exit code when a startup stage fails.
const EXIT_STARTUP_FAILED: i32 = 2;

/// Installs the `ring` rustls provider as the process default. The shared HTTP client and every
/// tungstenite client of later steps take it from there. Idempotent.
pub fn install_crypto_provider() {
    // `Err` means a provider is already installed, which is the state this call wants.
    let _already_installed = rustls::crypto::ring::default_provider().install_default();
}

/// Registers the work this step owns. `Paths`, `Logging`, `Handlers` and `Window` only.
fn register_stages() {
    startup::register(Stage::Paths, "resolve app paths", resolve_paths);
    startup::register(Stage::Logging, "init logging", init_logging);
    startup::register(Stage::Handlers, "mount events", mount_events);
    startup::register(Stage::Window, "create main window", create_main_window);
}

fn path_error(error: impl std::fmt::Display) -> CommandError {
    CommandError::new(ErrorKind::Internal, "app_paths", error.to_string())
}

fn resolve_paths(app: &AppHandle<Wry>) -> Result<(), CommandError> {
    let env = app.state::<LaunchEnv>();
    let defaults = app.path();
    let paths = AppPaths::resolve(
        &env,
        defaults.app_data_dir().map_err(path_error)?,
        defaults.app_log_dir().map_err(path_error)?,
    );
    app.manage(paths);
    Ok(())
}

fn init_logging(app: &AppHandle<Wry>) -> Result<(), CommandError> {
    let guard: LogGuard = logging::init(&app.state::<AppPaths>());
    app.manage(guard);
    logging::log_startup(env!("CARGO_PKG_VERSION"), BuildKind::current().into());
    Ok(())
}

fn mount_events(app: &AppHandle<Wry>) -> Result<(), CommandError> {
    registry::builder().mount_events(app);
    Ok(())
}

fn create_main_window(app: &AppHandle<Wry>) -> Result<(), CommandError> {
    let state = StartupState::default();
    windows::create_main(app, &state)
        .map(|_| ())
        .map_err(|error| CommandError::new(ErrorKind::Internal, "create_window", error.to_string()))
}

/// Builds and runs the app. `context` carries the profile identifier `main.rs` set.
pub fn run(env: LaunchEnv, context: tauri::Context<Wry>) {
    register_stages();
    #[cfg(feature = "e2e")]
    e2e::register_stages();
    let builder = registry::builder();
    #[cfg(feature = "e2e")]
    let gate = memry_desktop::e2e::E2eGate::from_env(&env);
    #[cfg(feature = "e2e")]
    let handler = e2e::dispatcher(
        gate,
        e2e::commands::handler(),
        registry::invoke_handler(&builder),
    );
    #[cfg(not(feature = "e2e"))]
    let handler = registry::invoke_handler(&builder);
    let app = tauri::Builder::default();
    #[cfg(feature = "e2e")]
    let app = e2e::install(app, gate);
    let result = app
        .manage(env)
        .invoke_handler(handler)
        .setup(|app| {
            if let Err(failure) = startup::run_registered(app.handle()) {
                tracing::error!(
                    stage = ?failure.stage,
                    name = failure.name,
                    "startup stage failed: {}",
                    failure.error
                );
                eprintln!("startup stage {} failed: {}", failure.name, failure.error);
                std::process::exit(EXIT_STARTUP_FAILED);
            }
            Ok(())
        })
        .run(context);
    if let Err(error) = result {
        tracing::error!("tauri runtime failed: {error}");
        eprintln!("tauri runtime failed: {error}");
        std::process::exit(1);
    }
}
