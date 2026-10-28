//! The quit of the app. `RunEvent::ExitRequested` starts one ordered, deadline-bound sequence
//! (`memry_desktop::shell::shutdown`); this module owns the latch, the crash-marker and process
//! effects, the steps this step registers, the signals, and the macOS keep-alive rules. Every
//! later owner registers its own step with [`ShutdownService::register`].

#[cfg(target_os = "macos")]
mod mac_quit;
mod signals;
mod steps;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, PoisonError};

use memry_desktop::session::Session;
#[cfg(target_os = "macos")]
use memry_desktop::shell::shutdown::is_implicit_exit;
use memry_desktop::shell::shutdown::{
    HARD_BACKSTOP, ShutdownCore, ShutdownEffects, ShutdownReason, StepFn, UnknownStep,
    UpdateApplyHook,
};
use memry_desktop::telemetry::crash::{CrashMarker, ShutdownFailure};
use tauri::{AppHandle, ExitRequestApi, Manager, RunEvent, Wry};

use crate::commands::error::CommandError;
use crate::startup::{self, Stage};

/// When the last app window was destroyed: the exit request that follows at once is the window
/// system's, not the user's (macOS keeps the app alive then).
#[cfg(target_os = "macos")]
static LAST_WINDOW_DESTROYED: Mutex<Option<std::time::Instant>> = Mutex::new(None);

pub struct ShutdownService {
    core: Arc<ShutdownCore>,
    /// The sequence ended cleanly: the exit it asked for may now pass.
    completed: AtomicBool,
}

impl ShutdownService {
    /// Registers `run` as (one of) the closures of step `name`; the names are `STEP_ORDER`.
    pub fn register(&self, name: &str, run: StepFn) -> Result<(), UnknownStep> {
        self.core.registry.register(name, run)
    }

    /// Step 38 (#3555) registers its updater here; with none the calls are skipped.
    pub fn set_update_hook(&self, hook: Arc<dyn UpdateApplyHook>) {
        self.core.set_update_hook(hook);
    }
}

pub fn register_stages() {
    startup::register(Stage::Handlers, "manage shutdown", manage);
    startup::register(Stage::Handlers, "register shutdown steps", steps::register);
    #[cfg(target_os = "macos")]
    startup::register(Stage::Handlers, "answer macOS terminate", mac_quit::install);
}

fn manage(app: &AppHandle<Wry>) -> Result<(), CommandError> {
    app.manage(ShutdownService {
        core: Arc::new(ShutdownCore::default()),
        completed: AtomicBool::new(false),
    });
    app.manage(crate::flush::FlushService::default());
    app.manage(memry_desktop::shell::close::CloseHooks::default());
    signals::spawn(app);
    Ok(())
}

struct TauriEffects {
    app: AppHandle<Wry>,
}

impl TauriEffects {
    fn with_marker(&self, f: impl FnOnce(&mut CrashMarker)) {
        if let Some(marker) = self.app.try_state::<Mutex<CrashMarker>>() {
            f(&mut marker.lock().unwrap_or_else(PoisonError::into_inner));
        }
    }
}

impl ShutdownEffects for TauriEffects {
    fn step_started(&self, step: &str) {
        self.with_marker(|marker| marker.mark_shutdown_step(step));
    }

    fn mark_failure(&self, failure: ShutdownFailure, step: Option<&str>) {
        self.with_marker(|marker| marker.mark_shutdown_failure(failure, step));
    }

    fn clear_marker(&self) {
        self.with_marker(CrashMarker::clear);
    }

    fn exit_clean(&self) {
        self.app
            .state::<ShutdownService>()
            .completed
            .store(true, Ordering::SeqCst);
        self.app.exit(0);
    }

    fn terminate(&self) {
        tracing::error!(scope = "Shutdown", "forcing exit");
        std::process::exit(1);
    }
}

/// Starts the sequence: the first exit request wins, later ones are held until it ends.
fn begin(app: &AppHandle<Wry>, api: &ExitRequestApi, reason: ShutdownReason) {
    api.prevent_exit();
    startup::mark_shutdown_started();
    // The window is on its way out: a vault close must not flip the UI to the vault picker.
    app.state::<Session>().begin_shutdown();
    let service = app.state::<ShutdownService>();
    let effects: Arc<dyn ShutdownEffects> = Arc::new(TauriEffects { app: app.clone() });
    tracing::info!(scope = "Shutdown", "starting graceful shutdown");
    service.core.arm_backstop(HARD_BACKSTOP, effects.clone());
    let core = service.core.clone();
    tauri::async_runtime::spawn(async move {
        core.run(reason, &effects).await;
    });
}

/// The registered update hook, `None` before Step 38 (#3555) registers one.
pub fn update_hook(app: &AppHandle<Wry>) -> Option<Arc<dyn UpdateApplyHook>> {
    app.state::<ShutdownService>().core.update_hook()
}

/// The sequence ended cleanly and the exit it asked for may pass. The Windows session-end handler
/// waits on this before it returns, because the OS ends the process soon after.
#[cfg(windows)]
pub fn is_completed(app: &AppHandle<Wry>) -> bool {
    app.state::<ShutdownService>()
        .completed
        .load(Ordering::SeqCst)
}

/// Starts the sequence for a quit that did not come through `ExitRequested`: the Windows session
/// end. Without a request to hold, the app is kept alive by the latch alone.
pub fn begin_session_end(app: &AppHandle<Wry>) {
    if startup::shutdown_started() {
        return;
    }
    startup::mark_shutdown_started();
    app.state::<Session>().begin_shutdown();
    let service = app.state::<ShutdownService>();
    let effects: Arc<dyn ShutdownEffects> = Arc::new(TauriEffects { app: app.clone() });
    tracing::info!(scope = "Shutdown", "starting graceful shutdown");
    service.core.arm_backstop(HARD_BACKSTOP, effects.clone());
    let core = service.core.clone();
    tauri::async_runtime::spawn(async move {
        core.run(ShutdownReason::SessionEnd, &effects).await;
    });
}

fn on_exit_requested(app: &AppHandle<Wry>, code: Option<i32>, api: &ExitRequestApi) {
    let service = app.state::<ShutdownService>();
    if service.completed.load(Ordering::SeqCst) {
        return;
    }
    if startup::shutdown_started() {
        api.prevent_exit();
        return;
    }
    // Closing the last window keeps the app alive on macOS; Cmd+Q and Dock Quit still quit.
    #[cfg(target_os = "macos")]
    if code.is_none()
        && is_implicit_exit(
            *LAST_WINDOW_DESTROYED
                .lock()
                .unwrap_or_else(PoisonError::into_inner),
        )
    {
        api.prevent_exit();
        return;
    }
    #[cfg(not(target_os = "macos"))]
    let _ = code;
    begin(app, api, ShutdownReason::Quit);
}

/// Called by the window-event dispatcher for every destroyed window.
pub fn on_window_destroyed(app: &AppHandle<Wry>, label: &str) {
    #[cfg(target_os = "macos")]
    {
        let others = app
            .webview_windows()
            .keys()
            .any(|other| other != label && crate::windows::registry::is_app_label(other));
        if !others {
            *LAST_WINDOW_DESTROYED
                .lock()
                .unwrap_or_else(PoisonError::into_inner) = Some(std::time::Instant::now());
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, label);
}

/// The `run` callback of the app.
pub fn on_run_event(app: &AppHandle<Wry>, event: &RunEvent) {
    if crate::windows::startup_error::startup_failed() {
        on_run_event_after_failed_startup(app, event);
        return;
    }
    match event {
        RunEvent::ExitRequested { code, api, .. } => on_exit_requested(app, *code, api),
        RunEvent::Exit => {
            // Windows leaves a ghost icon in the notification area if the process ends with a
            // live tray.
            crate::tray::destroy(app);
            app.state::<crate::shortcuts::ShortcutService>()
                .release_all(app);
            app.state::<ShutdownService>().core.apply_on_quit();
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen {
            has_visible_windows: false,
            ..
        } => crate::windows::main_window::reopen(app),
        _ => {}
    }
}

/// The app runs only for the startup-error window: closing it quits with the failure's exit
/// code, and no quit sequence runs over services that may never have started.
fn on_run_event_after_failed_startup(app: &AppHandle<Wry>, event: &RunEvent) {
    use crate::windows::startup_error::EXIT_STARTUP_FAILED;
    match event {
        RunEvent::ExitRequested {
            code: None, api, ..
        } => {
            api.prevent_exit();
            app.exit(EXIT_STARTUP_FAILED);
        }
        RunEvent::Exit => crate::tray::destroy(app),
        _ => {}
    }
}
