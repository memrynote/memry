//! Typed events. Every event is a struct deriving `tauri_specta::Event`, named
//! `<Domain><Noun><Verb>Event` (`CalendarChangedEvent`, `SyncStatusChangedEvent`). Domain steps
//! add their events here and list them in `registry.rs`; none calls `emit` directly.

use memry_desktop::ai::settings::InlineAiSettings;
use memry_desktop::journal::JournalEntryView;
use memry_desktop::notes::index::{IndexProgress, LinkChanges};
use memry_desktop::notes::view::NoteListItemView;
use memry_desktop::session::response::VaultStatus;
use memry_desktop::updater::state::AppUpdateState;
use memry_desktop::vault::config::VaultConfig;
use serde::Serialize;
use tauri::{AppHandle, Emitter, EventTarget, Runtime};

use crate::commands::vault_locks::VaultLockStateView;

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

/// The vault closed, so every window's editor is bound to a document nothing serves
/// (`crdt:provider-reset`). Not the moment to reopen: wait for [`CrdtProviderReadyEvent`].
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
pub struct CrdtProviderResetEvent;

/// The vault at `vault_path` serves `crdt_open_doc` again (`crdt:provider-ready`): a window whose
/// binding went stale reopens its note and redoes the handshake.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct CrdtProviderReadyEvent {
    pub vault_path: String,
}

/// A custom icon was added, renamed or deleted (`custom-icons:updated`). The renderer refetches
/// the library.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct CustomIconsUpdatedEvent {
    pub id: String,
}

/// A day's entry was made on its first write, or its file appeared outside the app
/// (`journal:entryCreated`).
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct JournalEntryCreatedEvent {
    pub date: String,
    pub entry: JournalEntryView,
    /// `external` for a file found outside the app; left out for the app's own write.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional, type = NoteEventSource)]
    pub source: Option<NoteEventSource>,
}

/// A day's entry was edited in the app or outside it (`journal:entryUpdated`).
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct JournalEntryUpdatedEvent {
    pub date: String,
    pub entry: JournalEntryView,
    /// `external` for an edit outside the app, on which an open editor takes the file's text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional, type = NoteEventSource)]
    pub source: Option<NoteEventSource>,
}

/// A day's entry was deleted, in the app or by its file's removal (`journal:entryDeleted`).
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct JournalEntryDeletedEvent {
    pub date: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional, type = NoteEventSource)]
    pub source: Option<NoteEventSource>,
}

/// A day's counts landed after the event of its save or edit went out (`journal:externalChange`,
/// which Electron defines and never sends): the renderer refetches the day's reads.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct JournalExternalChangeEvent {
    pub date: String,
    #[serde(rename = "type")]
    pub kind: JournalExternalChange,
}

/// `JournalExternalChangeEvent.type`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum JournalExternalChange {
    Modified,
}

/// Journal events were dropped because their forwarder fell behind (no Electron channel:
/// Electron sends every event). No payload; the renderer refetches its journal reads and, unless
/// the open day holds unsaved text, that day.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
pub struct JournalEventsDroppedEvent;

/// A template was created or duplicated (`templates:created`). The renderer refetches the list.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct TemplateCreatedEvent {
    pub id: String,
}

/// A template was saved (`templates:updated`). The renderer refetches the list.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct TemplateUpdatedEvent {
    pub id: String,
}

/// A template was deleted (`templates:deleted`). The renderer refetches the list.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct TemplateDeletedEvent {
    pub id: String,
}

/// Entries of the vault activity log were added or removed, or the vault closed
/// (`vault-activity:changed`). No payload; the renderer refetches. Throttled by the log.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
pub struct VaultActivityChangedEvent;

/// The open vault's notices changed, or a vault opened or closed. No payload; the renderer
/// reads `vault_notices_list`.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
pub struct VaultNoticesChangedEvent;

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

/// A note's file changed outside the app (`notes:updated`). `changes` holds the fields the
/// edit may have changed, as the note reads now (`NoteView::changes`); the body reaches the
/// open editor through its document.
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

/// A note's file moved or the app renamed the note (`notes:renamed`), by the app or by a move
/// outside it. A rename to a title the file name already says names one path. `newTitle` is the
/// title the note has now; `oldTitle` is the old file's name without `.md`, as Electron's
/// watcher sends it (no renderer reads it).
#[derive(
    Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event,
)]
#[serde(rename_all = "camelCase")]
pub struct NoteRenamedEvent {
    pub id: String,
    pub old_path: String,
    pub new_path: String,
    pub old_title: String,
    pub new_title: String,
}

/// The app moved a note to another folder (`notes:moved`, Electron's `moveNote`). The title
/// stays; the renderer refetches what it shows of the note.
#[derive(
    Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event,
)]
#[serde(rename_all = "camelCase")]
pub struct NoteMovedEvent {
    pub id: String,
    pub old_path: String,
    pub new_path: String,
}

/// An outside edit of the note's file met typing the file did not have yet, and the typing won
/// (`notes:outside-edit-kept`, #4030): the outside text is kept as a version, and the write-back
/// writes the typing over it. No Electron channel: Electron's editor held the outside edit
/// itself.
#[derive(
    Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event,
)]
#[serde(rename_all = "camelCase")]
pub struct NoteOutsideEditKeptEvent {
    pub id: String,
}

/// Note events were dropped because their forwarder fell behind (no Electron channel: Electron
/// sends every event). No payload; the renderer refetches its note lists, its tags and every
/// note it shows.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
pub struct NoteEventsDroppedEvent;

/// The note index committed links that changed (`notes:links-changed`): the notes whose links
/// changed, and every note that gained or lost a link to it. Sent after the rows are written,
/// so a links panel refetching on it reads them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct NoteLinksChangedEvent {
    pub source_ids: Vec<String>,
    pub target_ids: Vec<String>,
}

impl From<LinkChanges> for NoteLinksChangedEvent {
    fn from(changes: LinkChanges) -> Self {
        Self {
            source_ids: changes.sources.into_iter().collect(),
            target_ids: changes.targets.into_iter().collect(),
        }
    }
}

/// A tag's colour changed (`tags:color-updated`).
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
pub struct TagColorUpdatedEvent {
    pub tag: String,
    pub color: String,
}

/// The tag hub's categories, or which tags sit in them, changed (`tags:categories-changed`).
/// `categoryId` names the category when one did; a drag names none.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct TagCategoriesChangedEvent {
    pub category_id: Option<String>,
}

/// What happened to a note in a tag, for [`TagNotesChangedEvent`].
#[derive(Debug, Clone, Copy, Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum TagNoteAction {
    Pinned,
    Unpinned,
    Removed,
}

/// A note was pinned in a tag, unpinned from it, or the tag was taken off it
/// (`tags:notes-changed`).
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct TagNotesChangedEvent {
    pub tag: String,
    pub note_id: String,
    pub action: TagNoteAction,
}

/// A tag went from the vault, deleted or merged into another (`tags:deleted`): `affectedNotes`
/// notes and days lost it.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct TagDeletedEvent {
    pub tag: String,
    pub affected_notes: u32,
}

/// A tag was renamed across the vault (`tags:renamed`): `affectedNotes` notes and days took the
/// new name.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct TagRenamedEvent {
    pub old_name: String,
    pub new_name: String,
    pub affected_notes: u32,
}

/// How far a tag rename got (`tags:progress`): `done` of `total` notes, for the run the
/// renderer named.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct TagsProgressEvent {
    pub run_id: String,
    pub done: u32,
    pub total: u32,
}

/// A property definition was created for a tag field (`properties:definition-changed`). The
/// renderer refetches the tag schemas.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct PropertyDefinitionChangedEvent {
    pub name: String,
}

/// Something the tag list shows changed (`notes:tags-changed`). No payload; the renderer
/// refetches.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
pub struct NoteTagsChangedEvent;

/// The open vault's settings changed (`vault:config-changed`), with the settings after it: an
/// in-app write, from any window, as Electron's `updateConfig` broadcasts it.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
pub struct VaultConfigChangedEvent(pub VaultConfig);

/// A folder's settings or its record changed, or the folder left the vault, by sync
/// (`notes:folder-config-updated`): the folder `path` names, vault-relative.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
pub struct FolderConfigUpdatedEvent {
    pub path: String,
}

/// A lock was set or lifted on this device, or a vault opened (`vault-locks:changed`): every
/// locked note id and folder path now.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct VaultLocksChangedEvent {
    pub notes: Vec<String>,
    pub folders: Vec<String>,
}

impl From<VaultLockStateView> for VaultLocksChangedEvent {
    fn from(state: VaultLockStateView) -> Self {
        Self {
            notes: state.notes,
            folders: state.folders,
        }
    }
}

/// A locked note's file changed or was removed outside the app, and its locked text was written
/// back; the outside text is a version of the note (`vault-locks:external-edit-restored`).
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct VaultLocksExternalEditRestoredEvent {
    pub note_id: String,
    pub path: String,
    pub title: String,
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

/// The inline AI settings were written (replaces Electron's `ai-inline:server-ready` as the
/// settings refresh). The key is masked.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct AiInlineSettingsChangedEvent {
    pub settings: InlineAiSettings,
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
