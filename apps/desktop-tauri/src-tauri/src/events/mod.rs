//! Typed events. Every event is a struct deriving `tauri_specta::Event`, named
//! `<Domain><Noun><Verb>Event` (`CalendarChangedEvent`, `SyncStatusChangedEvent`), defined in
//! `events/<area>.rs` and listed in `registry/<area>.rs`. None calls `emit` directly.

use serde::Serialize;
use tauri::{AppHandle, Emitter, EventTarget, Runtime};

mod account;
mod agent;
mod ai;
mod bookmarks;
mod calendar;
mod canvas;
mod custom_icons;
mod editor;
mod home_pages;
mod inbox;
mod journal;
mod notes;
mod readwise;
mod reminders;
mod settings;
mod shell;
mod stickies;
mod sync;
mod tags;
mod tasks;
mod templates;
mod updater;
mod vault;
mod voice;

pub use account::*;
pub use agent::*;
pub use ai::*;
pub use bookmarks::*;
pub use calendar::*;
pub use canvas::*;
pub use custom_icons::*;
pub use editor::*;
pub use home_pages::*;
pub use inbox::*;
pub use journal::*;
pub use notes::*;
pub use readwise::*;
pub use reminders::*;
pub use settings::*;
pub use shell::*;
pub use stickies::*;
pub use sync::*;
pub use tags::*;
pub use tasks::*;
pub use templates::*;
pub use updater::*;
pub use vault::*;
pub use voice::*;

/// Emit `event` to every webview: the one window-wide emit (inv09#66). Each listener gets it once.
/// The generated `listen` registers for any target, and Tauri hands every such listener each
/// `emit_to` as well, so a `send_to` per window would deliver one copy per window. A failed
/// delivery is logged and swallowed, because callers run inside database transactions
/// (`apps/desktop/src/main/lib/window-broadcast.ts`). The wire name is the one
/// `tauri_specta::Event` derives.
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
/// [`broadcast`]. A listener registered without a target (the generated `listen`) receives it in
/// every webview, so a second window that runs the renderer subscribes for its own window.
pub fn send_to<R, E>(app: &AppHandle<R>, label: &str, event: E)
where
    R: Runtime,
    E: tauri_specta::Event + Serialize + Clone,
{
    if let Err(error) = app.emit_to(EventTarget::webview_window(label), E::NAME, &event) {
        tracing::warn!("Failed to deliver {} to {label}: {error}", E::NAME);
    }
}
