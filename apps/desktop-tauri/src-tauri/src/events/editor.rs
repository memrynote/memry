//! CRDT editor events: the provider reset and ready, and a failed write-back.

use serde::Serialize;

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
