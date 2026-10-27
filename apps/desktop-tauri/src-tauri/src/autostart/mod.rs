//! Start on boot (`general.startOnBoot`). One owner of the login item: every write of the
//! setting and every vault open with it on call [`apply`]. macOS registers through
//! `SMAppService`, which is the registration Electron's `setLoginItemSettings` made, so an
//! existing login item reads as enabled and no second one appears. Windows writes its own `Run`
//! value (quoted) and Linux uses the autostart plugin; both first remove the entry an Electron
//! install wrote.

#[cfg(target_os = "macos")]
mod mac;
#[cfg(not(any(target_os = "macos", windows)))]
mod other;
#[cfg(windows)]
mod win;

use memry_desktop::e2e::E2eGate;
use memry_desktop::launch_env::LaunchEnv;
use memry_desktop::session::Session;
use memry_desktop::settings::SettingsService;
use serde_json::Value;
use tauri::{AppHandle, Manager, Wry};

use crate::commands::error::{CommandError, ErrorKind};

#[cfg(target_os = "macos")]
use mac as platform;
#[cfg(not(any(target_os = "macos", windows)))]
use other as platform;
#[cfg(windows)]
use win as platform;

/// Brings the OS login item in line with `enabled`; safe to repeat.
pub fn apply(app: &AppHandle<Wry>, enabled: bool) -> Result<(), CommandError> {
    // A spec must never leave a login item pointing at a test binary on the machine running it.
    // The OS registration is checked on the VM rows and by hand instead.
    if cfg!(feature = "e2e") && E2eGate::from_env(&app.state::<LaunchEnv>()).is_open() {
        tracing::info!(
            scope = "Autostart",
            "e2e gate open; start on boot {enabled} not applied to the OS"
        );
        return Ok(());
    }
    platform::apply(app, enabled).map_err(|message| {
        tracing::warn!(
            scope = "Autostart",
            "could not set start on boot to {enabled}: {message}"
        );
        CommandError::new(ErrorKind::Internal, "autostart_failed", message)
    })
}

/// `general.startOnBoot` of the open vault; false with none open.
fn start_on_boot(app: &AppHandle<Wry>) -> bool {
    let vault = app
        .try_state::<Session>()
        .and_then(|session| session.current());
    app.try_state::<SettingsService>()
        .and_then(|settings| settings.read_group(vault.as_ref(), "general").ok())
        .is_some_and(|read| read.value.get("startOnBoot") == Some(&Value::Bool(true)))
}

/// A write of `general` that touched `startOnBoot` applies the new value.
/// The setting is saved either way; the error says the login item could not follow it.
pub fn on_general_written(app: &AppHandle<Wry>, fields: &[String]) -> Result<(), CommandError> {
    if fields.iter().any(|field| field == "startOnBoot") {
        return apply(app, start_on_boot(app));
    }
    Ok(())
}

/// A vault opened. With the setting on, the login item is re-asserted, which is what honors an
/// Electron login item on the first Tauri launch and drops its stale twin. With it off nothing
/// is touched: only a write of the setting turns it off, as in Electron.
pub fn on_vault_opened(app: &AppHandle<Wry>) {
    if start_on_boot(app) {
        // Nothing waits for this one; `apply` logs a failure with its context.
        let _ = apply(app, true);
    }
}
