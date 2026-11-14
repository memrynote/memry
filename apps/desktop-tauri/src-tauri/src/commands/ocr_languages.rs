//! The OCR languages row of Settings > General (`ocr-languages-handlers.ts`): read, choose and
//! retry, over `memry_desktop::services::ocr_languages`. The service starts converging once the
//! main window shows and again on every UI language change (`startOcrLanguages`, Electron
//! `index.ts:1677`).

use std::sync::Arc;

use memry_desktop::config::RuntimeConfig;
use memry_desktop::locale::LocaleService;
use memry_desktop::paths::AppPaths;
use memry_desktop::registry::AppConfig;
use memry_desktop::seams::transport::SyncTransport;
use memry_desktop::services::ocr_languages::{
    DOWNLOAD_TIMEOUT, OcrLanguage, OcrLanguages, OcrLanguagesDeps, OcrLanguagesState, PINS,
};
use tauri::{AppHandle, Listener, Manager, Wry};

use super::error::{CommandError, ErrorKind, log_failure};
use crate::events::{LocaleChangedEvent, OcrLanguagesChangedEvent, broadcast};
use crate::startup::{self, Stage};

pub fn register_stages() {
    startup::register(Stage::Handlers, "manage OCR languages", manage);
}

/// After telemetry has managed the `RuntimeConfig` (the sync server URL) and the `SyncTransport`.
fn manage(app: &AppHandle<Wry>) -> Result<(), CommandError> {
    let events = app.clone();
    let service = OcrLanguages::new(OcrLanguagesDeps {
        config: app.state::<Arc<AppConfig>>().inner().clone(),
        locale: app.state::<Arc<LocaleService>>().inner().clone(),
        app_data_dir: app.state::<AppPaths>().data_dir.clone(),
        server_url: app.state::<RuntimeConfig>().sync_server_url.clone(),
        transport: app.state::<SyncTransport>().inner().clone(),
        pins: PINS,
        download_timeout: DOWNLOAD_TIMEOUT,
        on_change: Box::new(move |state| broadcast(&events, OcrLanguagesChangedEvent(state))),
        runtime: tauri::async_runtime::handle().inner().clone(),
    });
    let on_locale = service.clone();
    app.listen_any(
        <LocaleChangedEvent as tauri_specta::Event>::NAME,
        move |_| on_locale.locale_changed(),
    );
    app.manage(service);
    Ok(())
}

/// Called once the main window shows: downloads what the app language needs.
pub fn on_window_shown(app: &AppHandle<Wry>) {
    if let Some(service) = app.try_state::<Arc<OcrLanguages>>() {
        service.start();
    }
}

fn service(app: &AppHandle<Wry>) -> Arc<OcrLanguages> {
    app.state::<Arc<OcrLanguages>>().inner().clone()
}

#[tauri::command]
#[specta::specta]
pub async fn ocr_languages_get_state(
    app: AppHandle<Wry>,
) -> Result<OcrLanguagesState, CommandError> {
    Ok(service(&app).state())
}

/// Stores the chosen languages (English is always added) and starts converging on them.
#[tauri::command]
#[specta::specta]
pub async fn ocr_languages_set(
    app: AppHandle<Wry>,
    languages: Vec<OcrLanguage>,
) -> Result<OcrLanguagesState, CommandError> {
    service(&app).set(&languages).map_err(|error| {
        tracing::warn!(
            scope = "OcrLanguages",
            "could not store the OCR languages: {error}"
        );
        // The settings row shows the translated key.
        let error = CommandError::new(
            ErrorKind::Storage,
            "ocr_languages_save_failed",
            "errors:ocrLanguages.saveFailed",
        );
        log_failure("ocr_languages_set", &error);
        error
    })
}

/// Clears the failed downloads and tries them again.
#[tauri::command]
#[specta::specta]
pub async fn ocr_languages_retry(app: AppHandle<Wry>) -> Result<OcrLanguagesState, CommandError> {
    Ok(service(&app).retry())
}
