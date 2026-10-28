//! The global capture shortcut commands (`registerGlobalCapture`, `setGlobalCapture`).

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
use super::settings::announce;
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
        let result = app
            .state::<ShortcutService>()
            .set(
                &app,
                || read_binding(&app, "globalCapture"),
                binding.as_ref(),
                || {
                    let mut patch = Map::new();
                    patch.insert("globalCapture".to_owned(), patch_value);
                    change = Some(
                        settings
                            .write_group(Some(&vault), "keyboard", patch)
                            .map_err(|error| format!("{error:?}"))?,
                    );
                    Ok(())
                },
            )
            .map_err(|message| CommandError::new(ErrorKind::Storage, "settings_failed", message))?;
        // After the shortcut lock is released: the announce re-applies, a no-op for what is held.
        if let Some(change) = change {
            announce(&app, &change.group, change.fields)?;
        }
        Ok(result)
    })
    .await
}
