//! The Tauri side of the in-app updater (`memry_desktop::updater::service`): picks the backend,
//! manages the one `UpdaterService`, forwards its state to every window, starts it after the main
//! window shows, and plugs it into the quit through the shutdown update hook.

use std::sync::Arc;
use std::time::Duration;

use memry_desktop::locale::LocaleService;
use memry_desktop::paths::AppPaths;
use memry_desktop::registry::AppConfig;
use memry_desktop::shell::shutdown::UpdateApplyHook;
use memry_desktop::updater::backend::UpdateBackend;
use memry_desktop::updater::service::{UpdaterDeps, UpdaterService};
use tauri::{AppHandle, Manager, Wry};

use crate::commands::error::CommandError;
use crate::events::{UpdaterStateChangedEvent, broadcast};
use crate::shell::services::telemetry;
use crate::shutdown::ShutdownService;
use crate::startup::{self, Stage};

/// The wait between the main window showing and the updater's first file read and feed check,
/// so none of it competes with the launch (Electron ran it at reveal).
const INIT_DELAY: Duration = Duration::from_secs(10);

pub fn register_stages() {
    startup::register(Stage::Handlers, "manage updater", manage);
}

/// The backend of this process and the delay before init. `None` until the Velopack backend
/// lands (#3555 38c): the updater reads `unavailable`.
fn backend(app: &AppHandle<Wry>) -> (Option<Arc<dyn UpdateBackend>>, Duration) {
    #[cfg(feature = "e2e")]
    if let Some(scripted) = scripted(app) {
        return (Some(scripted), Duration::ZERO);
    }
    let _ = app;
    tracing::info!(scope = "Updater", "no update backend in this build");
    (None, INIT_DELAY)
}

/// `MEMRY_TEST_UPDATER=scripted` under an open e2e gate: the scripted backend, managed for the
/// `e2e_updater_*` commands. A spec scripts it after launch, so init runs at once.
#[cfg(feature = "e2e")]
fn scripted(app: &AppHandle<Wry>) -> Option<Arc<dyn UpdateBackend>> {
    use memry_desktop::e2e::E2eGate;
    use memry_desktop::launch_env::LaunchEnv;
    use memry_desktop::updater::scripted::ScriptedBackend;

    let env = app.state::<LaunchEnv>();
    if !E2eGate::from_env(&env).is_open() || env.get("MEMRY_TEST_UPDATER") != Some("scripted") {
        return None;
    }
    let backend = Arc::new(ScriptedBackend::new(
        app.state::<AppPaths>().data_dir.clone(),
        Duration::from_millis(150),
    ));
    app.manage(backend.clone());
    Some(backend)
}

/// macOS: the bundle runs outside `/Applications` and `~/Applications`, where a read-only volume
/// error means the app has to be moved first.
fn outside_applications() -> bool {
    if !cfg!(target_os = "macos") {
        return false;
    }
    let Ok(exe) = std::env::current_exe() else {
        return false;
    };
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
    let roots = [
        Some(std::path::PathBuf::from("/Applications")),
        home.map(|h| h.join("Applications")),
    ];
    !roots.iter().flatten().any(|root| exe.starts_with(root))
}

fn manage(app: &AppHandle<Wry>) -> Result<(), CommandError> {
    let (backend, delay) = backend(app);
    let service = UpdaterService::new(UpdaterDeps {
        raw_version: app.package_info().version.to_string(),
        backend,
        config: app.state::<Arc<AppConfig>>().inner().clone(),
        data_dir: app.state::<AppPaths>().data_dir.clone(),
        telemetry: telemetry(app),
        locale: app.state::<Arc<LocaleService>>().inner().clone(),
        outside_applications: outside_applications(),
        runtime: tauri::async_runtime::handle().inner().clone(),
    });
    app.manage(service.clone());
    app.manage(InitDelay(delay));
    app.state::<ShutdownService>()
        .set_update_hook(Arc::new(Hook {
            service: service.clone(),
            app: app.clone(),
        }));
    forward_state(app, &service);
    Ok(())
}

struct InitDelay(Duration);

/// Every state change reaches every window. The `watch` receiver keeps only the latest value, so
/// a burst of progress ticks costs one event per wake.
fn forward_state(app: &AppHandle<Wry>, service: &UpdaterService) {
    let mut states = service.subscribe();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        while states.changed().await.is_ok() {
            let state = states.borrow_and_update().clone();
            broadcast(&app, UpdaterStateChangedEvent(state));
        }
    });
}

/// Called once the main window shows: starts the service after its delay.
pub fn on_window_shown(app: &AppHandle<Wry>) {
    let Some(service) = app.try_state::<Arc<UpdaterService>>() else {
        return;
    };
    let service = service.inner().clone();
    let delay = app.try_state::<InitDelay>().map_or(INIT_DELAY, |d| d.0);
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(delay).await;
        service.init();
    });
}

/// The shutdown sequence's view of the updater. A hand-off replaces the exit, so after it the
/// process ends here.
struct Hook {
    service: Arc<UpdaterService>,
    app: AppHandle<Wry>,
}

impl UpdateApplyHook for Hook {
    fn disable_install_on_quit(&self) {
        self.service.disable_install_on_quit();
    }

    fn enable_install_on_quit(&self) {
        self.service.enable_install_on_quit();
    }

    fn install_requested(&self) -> bool {
        self.service.install_requested()
    }

    fn apply_and_restart(&self) {
        // A failed hand-off is in the state and the install streak; the quit goes on either way,
        // since the user's data is already flushed and the window is gone.
        self.service.apply_and_restart();
        crate::shutdown::exit_after_install(&self.app);
    }

    fn apply_on_quit(&self) {
        self.service.apply_on_quit();
    }
}
