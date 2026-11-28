//! Window chrome, navigation, flush and menu events.

use serde::Serialize;

/// The main window's maximized or fullscreen state changed (emitted on resize). The renderer
/// sets `data-fullscreen` on `<html>` and the caption button glyph from it.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct WindowChromeStateChangedEvent {
    pub fullscreen: bool,
    pub maximized: bool,
}

/// The pointer is over a native caption button (`minimize`, `maximize`, `close`) or left them.
/// Windows only: the page receives no mouse events for those hit-test regions.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct WindowCaptionHoverChangedEvent {
    pub button: Option<String>,
}

/// A native caption button is held down, or released.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct WindowCaptionPressedChangedEvent {
    pub button: Option<String>,
}

/// Back or forward from a trackpad swipe or a browser key (`back` or `forward`).
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct AppNavigationRequestedEvent {
    pub direction: String,
}

/// Main asks a window to write its unsaved edits (`flush-requested-event`); the window answers with
/// the `flush_done` command and the same id.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct FlushRequestedEvent {
    pub request_id: String,
}

/// A native menu item that the renderer runs as a command was clicked. `command` is the
/// command id (`tabs.closeTab`).
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct MenuCommandInvokedEvent {
    pub command: String,
}
