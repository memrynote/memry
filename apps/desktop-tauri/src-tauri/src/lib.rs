//! MemryNote desktop shell. `run()` owns the boot sequence; domain steps register startup work
//! with `startup::register` and commands in `registry.rs`.

pub mod autostart;
pub mod badge;
pub mod binary;
pub mod commands;
pub mod deep_link;
#[cfg(feature = "e2e")]
pub mod e2e;
pub mod events;
pub mod flush;
pub mod fonts;
pub mod guards;
pub mod instance;
pub mod menu;
pub mod notifications;
pub mod power;
pub mod registry;
pub mod shell;
pub mod shortcuts;
pub mod shutdown;
pub mod spell;
pub mod startup;
pub mod tray;
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

/// A non-Velopack Windows layout names the process `com.memrynote.memry`, the id the shortcut and
/// the toast carry. A Velopack install keeps the one its bootstrap set, or Windows would show a
/// second taskbar icon (`apps/desktop/src/main/windows-install-layout.ts`).
#[cfg(windows)]
pub fn set_app_user_model_id() {
    use memry_desktop::shell::install_layout::app_user_model_id_override;
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let exists = |path: &str| std::path::Path::new(path).exists();
    let Some(id) = app_user_model_id_override(&exe.to_string_lossy(), exists) else {
        return;
    };
    // SAFETY: a plain call with a valid, null-terminated string that lives for the call.
    let result = unsafe {
        ::windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID(
            &::windows::core::HSTRING::from(id),
        )
    };
    if let Err(error) = result {
        eprintln!("could not set the AppUserModelID: {error}");
    }
}

/// Registers the boot work of the shell: paths, logging, events, the vault session and the
/// window.
fn register_stages() {
    startup::register(Stage::Paths, "resolve app paths", resolve_paths);
    startup::register(Stage::Logging, "init logging", init_logging);
    guards::register_stages();
    shell::services::register_stages();
    startup::register(Stage::Handlers, "mount events", mount_events);
    shell::vault_boot::register_stages();
    shutdown::register_stages();
    tray::register_stages();
    windows::close::register_stages();
    deep_link::register_stages();
    notifications::register_stages();
    shortcuts::register_stages();
    spell::register_stages();
    startup::register(Stage::Window, "create main window", create_main_window);
    // After the window exists: Windows subclasses its handle.
    power::register_stages();
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
    // Single instance first: a second launch must hand off before anything else starts.
    #[cfg(feature = "e2e")]
    let single_instance_off = gate.is_open();
    #[cfg(not(feature = "e2e"))]
    let single_instance_off = false;
    let app = instance::install(tauri::Builder::default(), single_instance_off)
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init());
    // macOS and Windows write their own login item (`autostart/`).
    #[cfg(target_os = "linux")]
    let app = app.plugin(
        tauri_plugin_autostart::Builder::new()
            .app_name(memry_desktop::shell::autostart::APP_NAME)
            .build(),
    );
    #[cfg(feature = "e2e")]
    let app = e2e::install(app, gate);
    let result = app
        .manage(env)
        .manage(badge::BadgeService::default())
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
