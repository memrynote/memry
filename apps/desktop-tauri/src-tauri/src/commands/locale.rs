//! The UI language: read, switch and list. `LocaleService` is the one place a locale becomes
//! live; persistence follows only after the switch succeeds.

use std::sync::Arc;

use memry_desktop::locale::{self, LocaleService, SUPPORTED};
use memry_desktop::registry::AppConfig;
use memry_desktop::session::Session;
use memry_desktop::settings::SettingsService;
use serde_json::{Map, Value};
use tauri::{AppHandle, Manager, Wry};

use super::blocking;
use super::error::{CommandError, ErrorKind};
use crate::events::{LocaleChangedEvent, SettingsChangedEvent, broadcast};
use crate::shell::services::telemetry;

#[tauri::command]
#[specta::specta]
pub async fn locale_get(app: AppHandle<Wry>) -> Result<String, CommandError> {
    Ok(app.state::<Arc<LocaleService>>().get().to_owned())
}

#[tauri::command]
#[specta::specta]
pub async fn locale_list() -> Result<Vec<String>, CommandError> {
    Ok(SUPPORTED
        .iter()
        .map(|locale| (*locale).to_owned())
        .collect())
}

/// Switches the language, then stores it in the app config, the open vault's preferences and
/// the synced `general.language`, and tells every window.
#[tauri::command]
#[specta::specta]
pub async fn locale_set(app: AppHandle<Wry>, locale: String) -> Result<(), CommandError> {
    let Some(supported) = locale::supported(&locale) else {
        return Err(CommandError::new(
            ErrorKind::Invalid,
            "locale_unsupported",
            format!("{locale} is not a supported language"),
        ));
    };
    let service = app.state::<Arc<LocaleService>>().inner().clone();
    if !service.switch(supported) {
        return Ok(());
    }
    crate::menu::apply(&app, true);
    let config: Arc<AppConfig> = app.state::<Arc<AppConfig>>().inner().clone();
    let settings = app.state::<SettingsService>().inner().clone();
    let vault = app.state::<Session>().current();
    blocking("locale_set", move || {
        locale::store(&config, supported);
        if vault.is_some() {
            let patch = Map::from_iter([("language".to_owned(), Value::from(supported))]);
            settings
                .write_group(vault.as_ref(), "general", patch)
                .map_err(|e| {
                    CommandError::new(ErrorKind::Storage, "settings_failed", e.to_string())
                })?;
        }
        Ok(())
    })
    .await?;
    if let Some(telemetry) = telemetry(&app) {
        telemetry.set_locale(supported);
    }
    broadcast(
        &app,
        LocaleChangedEvent {
            locale: supported.to_owned(),
        },
    );
    broadcast(
        &app,
        SettingsChangedEvent {
            key: "general".to_owned(),
            fields: vec!["language".to_owned()],
        },
    );
    Ok(())
}
