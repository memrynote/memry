//! Typed events. Every event is a struct deriving `tauri_specta::Event`, named
//! `<Domain><Noun><Verb>Event` (`CalendarChangedEvent`, `SyncStatusChangedEvent`). Domain steps
//! add their events here and list them in `registry.rs`; none calls `emit` directly.

use memry_desktop::notes::index::IndexProgress;
use memry_desktop::notes::view::NoteListItemView;
use memry_desktop::session::response::VaultStatus;
use memry_desktop::updater::state::AppUpdateState;
use serde::Serialize;
use tauri::{AppHandle, Emitter, EventTarget, Runtime};

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

/// A note's file could not be updated from its body (`sync:write-back-failed`), once per run
/// of failed write-backs of the note. `title` is `None` when it could not be read.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct CrdtWriteBackFailedEvent {
    pub note_id: String,
    pub title: Option<String>,
    pub reason: WriteBackFailureReason,
}

/// Why a run of failed write-backs began: `write` when a read or a write failed (the next edit
/// tries again), `frontmatter` when the file's frontmatter does not parse (the file is left
/// alone until it is fixed).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum WriteBackFailureReason {
    Write,
    Frontmatter,
}

/// A custom icon was added, renamed or deleted (`custom-icons:updated`). The renderer refetches
/// the library.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct CustomIconsUpdatedEvent {
    pub id: String,
}

/// Entries of the vault activity log were added or removed, or the vault closed
/// (`vault-activity:changed`). No payload; the renderer refetches. Throttled by the log.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
pub struct VaultActivityChangedEvent;

/// Who made a note change (`NoteEventSource`): the app, or an edit outside it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum NoteEventSource {
    Internal,
    External,
}

/// A note was made, by the app or from a file that appeared (`notes:created`).
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct NoteCreatedEvent {
    pub note: NoteListItemView,
    pub source: NoteEventSource,
}

/// A note's file changed outside the app (`notes:updated`). `changes` is empty: the body
/// reaches the open editor through its document, and the lists refetch.
#[derive(
    Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event,
)]
#[serde(rename_all = "camelCase")]
pub struct NoteUpdatedEvent {
    pub id: String,
    pub changes: serde_json::Map<String, serde_json::Value>,
    pub source: NoteEventSource,
}

/// A note was deleted, in the app or by its file's removal (`notes:deleted`).
#[derive(
    Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event,
)]
#[serde(rename_all = "camelCase")]
pub struct NoteDeletedEvent {
    pub id: String,
    pub path: String,
    pub source: NoteEventSource,
}

/// The registry list or a vault's icon changed (`vault:list-changed`).
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
pub struct VaultListChangedEvent;

/// A reindex, or an open's first index pass, measured `index_built` of `index_total` notes
/// (`vault:index-progress`). At most one per 250 ms and never backwards within a pass. A pass
/// that read every file ends with `index_built == index_total` (`0` of `0` for an open with
/// nothing to measure); one a close or a failed write stops ends without it.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct VaultIndexProgressEvent {
    pub index_built: u32,
    pub index_total: u32,
}

impl From<IndexProgress> for VaultIndexProgressEvent {
    fn from(step: IndexProgress) -> Self {
        let count = |n: usize| u32::try_from(n).unwrap_or(u32::MAX);
        Self {
            index_built: count(step.built),
            index_total: count(step.total),
        }
    }
}

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

/// Open an inbox item (`inbox-open-item-event`): `memry://open?item=<id>` and, with Step 27
/// (#3544), a clicked inbox notification.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct InboxOpenItemEvent {
    pub item_id: String,
}

/// A native menu item that the renderer runs as a command was clicked. `command` is the
/// command id (`tabs.closeTab`).
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct MenuCommandInvokedEvent {
    pub command: String,
}

/// The updater state changed (`updater:state-changed`). The whole state, which the renderer
/// replaces wholesale; a burst of progress ticks reaches it as the latest value only.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
pub struct UpdaterStateChangedEvent(pub AppUpdateState);
