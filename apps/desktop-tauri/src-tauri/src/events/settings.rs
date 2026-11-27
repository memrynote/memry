//! Settings, locale and OCR language events.

use memry_desktop::services::ocr_languages::OcrLanguagesState;
use serde::Serialize;

/// A settings group or flat key was written (`settings:changed`). Names only, never values; the
/// renderer reads the current value through the get commands.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct SettingsChangedEvent {
    pub key: String,
    pub fields: Vec<String>,
}

/// The UI language changed (`locale:changed`).
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct LocaleChangedEvent {
    pub locale: String,
}

/// The OCR languages or a download of their data changed (`ocr-languages:changed`).
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
pub struct OcrLanguagesChangedEvent(pub OcrLanguagesState);

/// Open the settings modal at a section (`settings:open-section`). Emitted by the steps that own
/// the deep links and the menu.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct SettingsOpenSectionEvent {
    pub section: String,
}
