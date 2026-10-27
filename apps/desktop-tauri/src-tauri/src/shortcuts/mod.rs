//! System-wide shortcuts over `tauri-plugin-global-shortcut`. The rules (statuses, the fallback,
//! register-first-save-second) are `memry_desktop::shell::shortcut`; this module is the keyboard
//! adapter, the settings read and the exit release. Quick capture itself belongs to Step 27
//! (#3544): it calls [`ShortcutService::set_open_handler`] with the window opener, and until then
//! a press only logs.

use std::str::FromStr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use memry_desktop::launch_env::LaunchEnv;
use memry_desktop::session::Session;
use memry_desktop::settings::SettingsService;
use memry_desktop::shell::shortcut::{
    GlobalCapture, GlobalCaptureResult, Keys, OnFire, RegisterError, ShortcutBinding,
    ShortcutStatus, is_wayland,
};
use memry_desktop::telemetry::main_warning::Level;
use serde_json::Value;
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::commands::error::CommandError;
use crate::shell::services::telemetry;
use crate::startup::{self, Stage};

/// Opens the quick capture window.
pub type OpenHandler = Arc<dyn Fn(&AppHandle<Wry>) + Send + Sync>;

#[derive(Default)]
pub struct ShortcutService {
    capture: Mutex<GlobalCapture>,
    open: Mutex<Option<OpenHandler>>,
    presses: AtomicU64,
}

pub fn register_stages() {
    startup::register(Stage::Handlers, "manage shortcuts", manage);
    startup::register(
        Stage::Shortcuts,
        "register global capture",
        apply_at_startup,
    );
}

fn manage(app: &AppHandle<Wry>) -> Result<(), CommandError> {
    app.manage(ShortcutService::default());
    Ok(())
}

fn apply_at_startup(app: &AppHandle<Wry>) -> Result<(), CommandError> {
    apply_from_settings(app);
    Ok(())
}

/// The keyboard seam over the plugin. A parse failure is `Unsupported`; any other refusal,
/// including this process already holding the accelerator, is `InUse`.
struct PluginKeys<'a>(&'a AppHandle<Wry>);

impl Keys for PluginKeys<'_> {
    fn register(&self, accelerator: &str, on_fire: OnFire) -> Result<(), RegisterError> {
        let shortcut = Shortcut::from_str(accelerator).map_err(|_| RegisterError::Unsupported)?;
        self.0
            .global_shortcut()
            .on_shortcut(shortcut, move |_, _, event| {
                if event.state == ShortcutState::Pressed {
                    on_fire();
                }
            })
            .map_err(|_| RegisterError::InUse)
    }

    fn unregister(&self, accelerator: &str) {
        let Ok(shortcut) = Shortcut::from_str(accelerator) else {
            return;
        };
        if let Err(error) = self.0.global_shortcut().unregister(shortcut) {
            tracing::warn!(
                scope = "Shortcuts",
                "could not release {accelerator}: {error}"
            );
        }
    }
}

impl ShortcutService {
    /// Step 27 (#3544) registers the quick capture opener here.
    pub fn set_open_handler(&self, handler: OpenHandler) {
        *self.open.lock().unwrap_or_else(PoisonError::into_inner) = Some(handler);
    }

    /// How many times the shortcut fired since launch.
    pub fn presses(&self) -> u64 {
        self.presses.load(Ordering::SeqCst)
    }

    /// The accelerators currently held: the configured one, then whether the fallback is.
    pub fn held(&self) -> (Option<String>, bool) {
        let capture = self.capture.lock().unwrap_or_else(PoisonError::into_inner);
        (capture.configured.held.clone(), capture.fallback_held())
    }

    /// What a press does. Runs on the main thread, so it only hands off.
    pub fn press(&self, app: &AppHandle<Wry>) {
        self.presses.fetch_add(1, Ordering::SeqCst);
        let handler = self
            .open
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        match handler {
            Some(handler) => handler(app),
            None => tracing::info!(
                scope = "QuickCapture",
                "shortcut pressed; no opener registered"
            ),
        }
    }

    fn on_fire(app: &AppHandle<Wry>) -> OnFire {
        let app = app.clone();
        Arc::new(move || app.state::<ShortcutService>().press(&app))
    }

    /// Converges on `binding`. Safe to call at startup, on every vault status change and after
    /// every keyboard settings write.
    pub fn apply(
        &self,
        app: &AppHandle<Wry>,
        binding: Option<&ShortcutBinding>,
    ) -> GlobalCaptureResult {
        let result = self
            .capture
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .apply(&PluginKeys(app), wayland(app), binding, Self::on_fire(app));
        self.report(app, &result);
        result
    }

    /// Register first, save second (`save` writes the setting). A refused binding is not saved.
    pub fn set(
        &self,
        app: &AppHandle<Wry>,
        read_previous: impl FnOnce() -> Option<ShortcutBinding>,
        binding: Option<&ShortcutBinding>,
        save: impl FnOnce() -> Result<(), String>,
    ) -> Result<GlobalCaptureResult, String> {
        let mut capture = self.capture.lock().unwrap_or_else(PoisonError::into_inner);
        // Read under the lock: two saves in flight would otherwise both restore the same old one.
        let previous = read_previous();
        let result = capture.set(
            &PluginKeys(app),
            wayland(app),
            previous.as_ref(),
            binding,
            Self::on_fire(app),
            save,
        )?;
        drop(capture);
        self.report(app, &result);
        Ok(result)
    }

    /// Releases every held accelerator (exit).
    pub fn release_all(&self, app: &AppHandle<Wry>) {
        self.capture
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .release_all(&PluginKeys(app));
    }

    fn report(&self, app: &AppHandle<Wry>, result: &GlobalCaptureResult) {
        let (code, action) = match result.status {
            ShortcutStatus::Unsupported => {
                ("shortcut_unsupported", "global_capture_register_failed")
            }
            ShortcutStatus::InUse => ("shortcut_in_use", "global_capture_register_failed"),
            _ => ("", ""),
        };
        let Some(service) = telemetry(app) else {
            return;
        };
        if !code.is_empty() {
            tracing::warn!(scope = "Settings", "global capture refused: {code}");
            service.track_main_log(Level::Warn, "Settings", action, Some(code), None, None);
        }
        let dead = self
            .capture
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .is_dead();
        if dead {
            // Quick capture has no shortcut at all for this install: countable, not just a log.
            service.track_main_log(
                Level::Warn,
                "QuickCapture",
                "global_shortcut_register_failed",
                None,
                None,
                None,
            );
        }
    }
}

fn wayland(app: &AppHandle<Wry>) -> bool {
    let env = app.state::<LaunchEnv>();
    cfg!(target_os = "linux") && is_wayland(env.get("XDG_SESSION_TYPE"), env.get("WAYLAND_DISPLAY"))
}

/// `keyboard.<field>` of the open vault, or its default (no binding) while none is open. The
/// vault session starts after the shortcuts stage, so at launch this reads the defaults.
pub fn read_binding(app: &AppHandle<Wry>, field: &str) -> Option<ShortcutBinding> {
    let vault = app
        .try_state::<Session>()
        .and_then(|session| session.current());
    let read = app
        .try_state::<SettingsService>()?
        .read_group(vault.as_ref(), "keyboard")
        .ok()?;
    match read.value.get(field) {
        Some(Value::Null) | None => None,
        Some(value) => serde_json::from_value(value.clone())
            .map_err(|error| {
                tracing::warn!(scope = "Shortcuts", "{field} is not a binding: {error}")
            })
            .ok(),
    }
}

/// Re-reads `keyboard.globalCapture` and converges.
pub fn apply_from_settings(app: &AppHandle<Wry>) -> GlobalCaptureResult {
    let binding = read_binding(app, "globalCapture");
    app.state::<ShortcutService>().apply(app, binding.as_ref())
}
