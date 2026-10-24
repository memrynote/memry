//! Typed events. Every event is a struct deriving `tauri_specta::Event`, named
//! `<Domain><Noun><Verb>Event` (`CalendarChangedEvent`, `SyncStatusChangedEvent`). Domain steps
//! add their events here and list them in `registry.rs`; none calls `emit` directly.

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
