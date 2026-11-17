//! The sticky's system-wide shortcut (`applyStickyShortcut`, `saveStickyShortcut` and
//! `applyStickyBinding` of `ipc/settings-handlers.ts`). It has no fallback, and it is held only
//! while a vault is open: drafts and settings live in the vault.

use std::sync::{Arc, PoisonError};

use memry_desktop::session::Session;
use memry_desktop::shell::shortcut::{OnFire, ShortcutBinding, ShortcutStatus, register_configured};
use memry_desktop::sticky::session::OpenRequest;
use memry_desktop::telemetry::main_warning::Level;
use serde::Serialize;
use tauri::{AppHandle, Manager, Wry};

use super::{PluginKeys, ShortcutService, read_binding, wayland};
use crate::shell::services::telemetry;

/// `StickyShortcutResult` of `@memry/contracts/settings-schemas`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
pub struct StickyShortcutResult {
    pub status: ShortcutStatus,
}

impl ShortcutService {
    /// Converges the sticky's shortcut on `binding`. Under Wayland nothing is registered.
    pub fn apply_sticky(
        &self,
        app: &AppHandle<Wry>,
        binding: Option<&ShortcutBinding>,
    ) -> ShortcutStatus {
        let mut sticky = self.sticky.lock().unwrap_or_else(PoisonError::into_inner);
        let keys = PluginKeys(app);
        let status = if wayland(app) {
            sticky.release(&keys);
            match binding {
                Some(_) => ShortcutStatus::Unsupported,
                None => ShortcutStatus::Unbound,
            }
        } else {
            register_configured(&keys, &mut sticky, binding, || {}, on_fire(app))
        };
        drop(sticky);
        report(app, status);
        status
    }

    /// Register first, save second (`saveStickyShortcut`): a refused binding is not saved and
    /// the previous one is registered again.
    pub fn set_sticky<E>(
        &self,
        app: &AppHandle<Wry>,
        previous: Option<&ShortcutBinding>,
        binding: Option<&ShortcutBinding>,
        save: impl FnOnce() -> Result<(), E>,
    ) -> Result<StickyShortcutResult, E> {
        let status = self.apply_sticky(app, binding);
        if matches!(status, ShortcutStatus::InUse | ShortcutStatus::Unsupported) {
            self.apply_sticky(app, previous);
            return Ok(StickyShortcutResult { status });
        }
        if let Err(error) = save() {
            self.apply_sticky(app, previous);
            return Err(error);
        }
        Ok(StickyShortcutResult { status })
    }
}

fn on_fire(app: &AppHandle<Wry>) -> OnFire {
    let app = app.clone();
    Arc::new(move || crate::windows::sticky::open(&app, OpenRequest::Shortcut))
}

fn report(app: &AppHandle<Wry>, status: ShortcutStatus) {
    let code = match status {
        ShortcutStatus::Unsupported => "shortcut_unsupported",
        ShortcutStatus::InUse => "shortcut_in_use",
        _ => return,
    };
    tracing::warn!(scope = "Settings", "sticky shortcut refused: {code}");
    if let Some(service) = telemetry(app) {
        service.track_main_log(
            Level::Warn,
            "Settings",
            "sticky_shortcut_register_failed",
            Some(code),
            None,
            None,
        );
    }
}

/// The open vault's `keyboard.stickyShortcut`, none while no vault is open.
pub(super) fn binding(app: &AppHandle<Wry>) -> Option<ShortcutBinding> {
    let vault_open = app
        .try_state::<Session>()
        .is_some_and(|session| session.current().is_some());
    vault_open
        .then(|| read_binding(app, "stickyShortcut"))
        .flatten()
}

/// `applyStickyShortcut`.
pub fn apply_from_settings(app: &AppHandle<Wry>) -> StickyShortcutResult {
    let binding = binding(app);
    StickyShortcutResult {
        status: app
            .state::<ShortcutService>()
            .apply_sticky(app, binding.as_ref()),
    }
}
