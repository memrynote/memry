//! MemryNote desktop shell. `run()` owns the boot sequence; domain steps register startup work
//! with `startup::register` and commands in `registry.rs`.

pub mod binary;
pub mod commands;
#[cfg(feature = "e2e")]
pub mod e2e;
pub mod events;
pub mod flush;
pub mod guards;
pub mod menu;
pub mod protocols;
pub mod registry;
pub mod shell;
pub mod shutdown;
pub mod startup;
#[cfg(feature = "update-probe")]
pub mod update_probe;
pub mod windows;

use memry_desktop::launch_env::LaunchEnv;
use memry_desktop::logging::{self, LogGuard};
use memry_desktop::paths::AppPaths;
use tauri::{AppHandle, Manager, Wry};

use crate::commands::app::BuildKind;
use crate::commands::error::{CommandError, ErrorKind};
use crate::startup::Stage;

/// Process exit code when a startup stage fails.
const EXIT_STARTUP_FAILED: i32 = 2;

/// Installs the `ring` rustls provider as the process default. The shared HTTP client and every
/// tungstenite client of later steps take it from there. Idempotent.
pub fn install_crypto_provider() {
    // `Err` means a provider is already installed, which is the state this call wants.
    let _already_installed = rustls::crypto::ring::default_provider().install_default();
}

/// Registers the boot work of the shell: paths, logging, events, the vault session and the
/// window.
fn register_stages() {
    startup::register(Stage::Paths, "resolve app paths", resolve_paths);
    startup::register(Stage::Logging, "init logging", init_logging);
    guards::register_stages();
    shell::services::register_stages();
    startup::register(
        Stage::Protocols,
        "loopback server",
        shell::loopback::start_server,
    );
    startup::register(Stage::Handlers, "mount events", mount_events);
    shell::vault_boot::register_stages();
    shutdown::register_stages();
    windows::close::register_stages();
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
    windows::events::manage(app);
    app.manage(menu::MenuService::default());
    app.manage(menu::popup::ContextMenuBroker::default());
    Ok(())
}

fn create_main_window(app: &AppHandle<Wry>) -> Result<(), CommandError> {
    let state = shell::services::startup_state(app);
    windows::create_main(app, &state)
        .map(|_| ())
        .map_err(|error| {
            CommandError::new(ErrorKind::Internal, "create_window", error.to_string())
        })?;
    shell::services::mark_phase(
        app,
        memry_desktop::launch_timeline::LaunchPhase::WindowCreated,
    );
    menu::apply(app, false);
    #[cfg(feature = "update-probe")]
    update_probe::spawn();
    Ok(())
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
    let app = protocols::register(tauri::Builder::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init());
    #[cfg(feature = "e2e")]
    let app = e2e::install(app, gate);
    let result = app
        .manage(env)
        .invoke_handler(handler)
        .on_window_event(windows::events::dispatch)
        .on_menu_event(menu::on_menu_event)
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
        .build(context)
        .map(|app| {
            app.run(|handle, event| shutdown::on_run_event(handle, &event));
        });
    if let Err(error) = result {
        tracing::error!("tauri runtime failed: {error}");
        eprintln!("tauri runtime failed: {error}");
        std::process::exit(1);
    }
}
