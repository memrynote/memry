//! Typed events. Every event is a struct deriving `tauri_specta::Event`, named
//! `<Domain><Noun><Verb>Event` (`CalendarChangedEvent`, `SyncStatusChangedEvent`). Domain steps
//! add their events here and list them in `registry.rs`; none calls `emit` directly.

use memry_desktop::session::response::VaultStatus;
use serde::Serialize;
use tauri::{AppHandle, Emitter, EventTarget, Runtime};

/// Emit `event` to every webview. A failed delivery is logged and swallowed, because callers
/// run inside database transactions (`apps/desktop/src/main/lib/window-broadcast.ts`). The wire
/// name is the one `tauri_specta::Event` derives.
pub fn broadcast<R, E>(app: &AppHandle<R>, event: E)
where
    R: Runtime,
    E: tauri_specta::Event + Serialize + Clone,
{
    if let Err(error) = app.emit(E::NAME, &event) {
        tracing::warn!("Failed to deliver {}: {error}", E::NAME);
    }
}

/// Emit `event` to the webview window labelled `label`, with the same guarantee as
/// [`broadcast`].
pub fn send_to<R, E>(app: &AppHandle<R>, label: &str, event: E)
where
    R: Runtime,
    E: tauri_specta::Event + Serialize + Clone,
{
    if let Err(error) = app.emit_to(EventTarget::webview_window(label), E::NAME, &event) {
        tracing::warn!("Failed to deliver {} to {label}: {error}", E::NAME);
    }
}

/// The open vault changed (`vault:status-changed`). The renderer reads the status once after
/// it subscribes, because events before that are not replayed.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
pub struct VaultStatusChangedEvent(pub VaultStatus);

/// A vault operation failed (`vault:error`).
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct VaultErrorEvent {
    pub message: String,
}

/// The registry list or a vault's icon changed (`vault:list-changed`).
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
pub struct VaultListChangedEvent;

/// `index.db` was rebuilt empty (`vault:index-recovered`). `reason` is `missing` for a first
/// open (nothing was repaired) and `corrupt` otherwise; `detail` is the core's text.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct VaultIndexRecoveredEvent {
    pub reason: String,
    pub detail: String,
}

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

/// Open the settings modal at a section (`settings:open-section`). Emitted by the steps that own
/// the deep links and the menu.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct SettingsOpenSectionEvent {
    pub section: String,
}

/// Main asks a window to write its unsaved edits (`flush-requested-event`); the window answers with
/// the `flush_done` command and the same id.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct FlushRequestedEvent {
    pub request_id: String,
}
