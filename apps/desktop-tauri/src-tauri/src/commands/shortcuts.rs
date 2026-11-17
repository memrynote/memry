//! The system-wide shortcut commands: global capture (`registerGlobalCapture`,
//! `setGlobalCapture`) and the sticky (`registerStickyShortcut`, `setStickyShortcut`).

use std::sync::Arc;

use memry_desktop::i18n::{self, Args};
use memry_desktop::locale::LocaleService;
use memry_desktop::session::Session;
use memry_desktop::settings::SettingsService;
use memry_desktop::shell::shortcut::{GlobalCaptureResult, ShortcutBinding};
use serde_json::{Map, Value};
use tauri::{AppHandle, Manager, State, Wry};

use super::blocking;
use super::error::{CommandError, ErrorKind};
use super::settings::{announce, map_error};
use crate::shortcuts::sticky::StickyShortcutResult;
use crate::shortcuts::{ShortcutService, read_binding};

/// Registers the saved binding (or the fallback) and says what the OS did.
#[tauri::command]
#[specta::specta]
pub async fn shortcut_register_global_capture(
    app: AppHandle<Wry>,
) -> Result<GlobalCaptureResult, CommandError> {
    blocking("shortcut_register_global_capture", move || {
        Ok(crate::shortcuts::apply_from_settings(&app))
    })
    .await
}

/// Register first, save second: a binding the OS refuses is not saved and the previous one is
/// registered again. Fails with the localized no-vault text while no vault is open.
#[tauri::command]
#[specta::specta]
pub async fn shortcut_set_global_capture(
    app: AppHandle<Wry>,
    service: State<'_, ShortcutService>,
    binding: Option<ShortcutBinding>,
) -> Result<GlobalCaptureResult, CommandError> {
    let _ = service;
    blocking("shortcut_set_global_capture", move || {
        let Some(vault) = app.state::<Session>().current() else {
            let locale = app.state::<Arc<LocaleService>>().get();
            return Err(CommandError::new(
                ErrorKind::Invalid,
                "no_vault_open",
                i18n::t(locale, "errors:ipc.noVaultOpen", &Args::new()),
            ));
        };
        let settings = app.state::<SettingsService>().inner().clone();
        let patch_value = binding
            .as_ref()
            .map(serde_json::to_value)
            .transpose()
            .map_err(|error| {
                CommandError::new(
                    ErrorKind::Invalid,
                    "settings_invalid_value",
                    error.to_string(),
                )
            })?
            .unwrap_or(Value::Null);
        let mut change = None;
        let result = app.state::<ShortcutService>().set(
            &app,
            || read_binding(&app, "globalCapture"),
            binding.as_ref(),
            || {
                let mut patch = Map::new();
                patch.insert("globalCapture".to_owned(), patch_value);
                change = Some(
                    settings
                        .write_group(Some(&vault), "keyboard", patch)
                        .map_err(map_error)?,
                );
                Ok(())
            },
        )?;
        // After the shortcut lock is released: the announce re-applies, a no-op for what is held.
        if let Some(change) = change {
            announce(&app, &change.group, change.fields)?;
        }
        Ok(result)
    })
    .await
}

/// Registers the sticky's saved binding (none while no vault is open) and says what the OS did.
#[tauri::command]
#[specta::specta]
pub async fn shortcut_register_sticky(
    app: AppHandle<Wry>,
) -> Result<StickyShortcutResult, CommandError> {
    blocking("shortcut_register_sticky", move || {
        Ok(crate::shortcuts::sticky::apply_from_settings(&app))
    })
    .await
}

/// Register first, save second, as [`shortcut_set_global_capture`].
#[tauri::command]
#[specta::specta]
pub async fn shortcut_set_sticky(
    app: AppHandle<Wry>,
    binding: Option<ShortcutBinding>,
) -> Result<StickyShortcutResult, CommandError> {
    blocking("shortcut_set_sticky", move || {
        let Some(vault) = app.state::<Session>().current() else {
            let locale = app.state::<Arc<LocaleService>>().get();
            return Err(CommandError::new(
                ErrorKind::Invalid,
                "no_vault_open",
                i18n::t(locale, "errors:ipc.noVaultOpen", &Args::new()),
            ));
        };
        let settings = app.state::<SettingsService>().inner().clone();
        let patch_value = serde_json::to_value(&binding).map_err(|error| {
            CommandError::new(
                ErrorKind::Invalid,
                "settings_invalid_value",
                error.to_string(),
            )
        })?;
        let previous = read_binding(&app, "stickyShortcut");
        let mut change = None;
        let result = app.state::<ShortcutService>().set_sticky(
            &app,
            previous.as_ref(),
            binding.as_ref(),
            || {
                let mut patch = Map::new();
                patch.insert("stickyShortcut".to_owned(), patch_value);
                change = Some(
                    settings
                        .write_group(Some(&vault), "keyboard", patch)
                        .map_err(map_error)?,
                );
                Ok(())
            },
        )?;
        if let Some(change) = change {
            announce(&app, &change.group, change.fields)?;
        }
        Ok(result)
    })
    .await
}
