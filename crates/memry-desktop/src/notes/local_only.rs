//! Local-only notes (`notes:set-local-only`, `notes:get-local-only-count` of
//! `ipc/notes-handlers.ts`): a note whose record and body never leave this device.
//!
//! The core owns the rule ([`memry_core::domain::notes::local_only`]): the flag lives on the
//! note's `note_files` row, `outbox::enqueue` withholds every change of a flagged note, turning
//! the flag on drops what was queued and keeps the server's copy as it is (no tombstone, as
//! Electron's `removePendingNoteSyncItems`), and turning it off queues the record and the whole
//! body. This module only refuses a note that is not live and answers with the note as the
//! renderer reads it.

use memry_core::domain::notes::local_only::LocalOnlyChange;

use super::error::{NotesError, SCOPE};
use super::read;
use super::view::NoteView;
use crate::error::{CoreError, FailureKind};
use crate::session::OpenVault;
use crate::telemetry::service::Service;

#[derive(Debug, thiserror::Error)]
pub enum LocalOnlyError {
    #[error(transparent)]
    Notes(#[from] NotesError),
    /// The note stays local-only and nothing was queued: its body does not fit in one update
    /// the server takes (chapter 07 §7.3).
    #[error("this note is too large to sync, so it stays on this device")]
    TooLargeToSync,
}

impl From<memry_core::api::errors::StorageError> for LocalOnlyError {
    fn from(error: memry_core::api::errors::StorageError) -> Self {
        Self::Notes(error.into())
    }
}

impl CoreError for LocalOnlyError {
    fn kind_and_code(&self) -> (FailureKind, &'static str) {
        match self {
            Self::Notes(error) => error.kind_and_code(),
            Self::TooLargeToSync => (FailureKind::Sync, "note_too_large_to_sync"),
        }
    }
}

/// Sets or clears the local-only flag of the live note `note_id` and returns the note.
pub fn set(
    open: &OpenVault,
    note_id: &str,
    local_only: bool,
    telemetry: Option<&Service>,
) -> Result<NoteView, LocalOnlyError> {
    let files = open.vault.note_files();
    // A tombstoned note can keep its row until its file goes; it is not changed.
    if files.listed_by_id(note_id)?.is_none() {
        return Err(NotesError::NotFound(note_id.to_owned()).into());
    }
    match files.set_local_only(note_id, local_only)? {
        LocalOnlyChange::TooLargeToSync { packed_bytes } => {
            tracing::warn!(
                scope = SCOPE,
                note_id,
                packed_bytes,
                "a note too large to sync stays local-only"
            );
            return Err(LocalOnlyError::TooLargeToSync);
        }
        change => tracing::info!(scope = SCOPE, note_id, ?change, "local-only changed"),
    }
    read::get(open, note_id, telemetry)?
        .ok_or_else(|| NotesError::NotFound(note_id.to_owned()).into())
}

/// How many notes are local-only (`countLocalOnlyNoteMetadata`).
pub fn count(open: &OpenVault) -> Result<i64, NotesError> {
    Ok(open.vault.note_files().local_only_count()?)
}
