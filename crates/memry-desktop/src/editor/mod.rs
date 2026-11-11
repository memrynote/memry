//! The note and journal documents as editor windows reach them (Step 14b, #3531).
//!
//! Core's [`Editor`](memry_core::api::editor::Editor) keeps the resident documents, stores each
//! window's edit with its outbox row and hands every committed update to its listeners. This
//! module adds the windows: [`EditorHost`] serves the open vault's editor, keeps one
//! [`Subscriber`] per window and document, and sends each update to every subscriber but the
//! window that sent it, as a [`frame`]. A window that is gone lets go of everything it held
//! ([`EditorHost::forget_window`], Electron's `forgetWindow`).

mod compaction;
mod host;
mod typing;
pub mod versions;

use std::sync::Arc;

use memry_core::api::editor::{EditorError, Notice, Origin, ReadOnly};
use memry_core::api::errors::AuthError;

pub use compaction::compact_due;
pub use host::{EditorHealth, EditorHost, HostEvent};
pub use typing::{BARRIER, BARRIER_WAIT, RELEASE, TypingHold};

use crate::error::{CoreError, FailureKind};

/// Sends one frame to a window's channel. False when the window can no longer receive.
pub type Deliver = Arc<dyn Fn(Vec<u8>) -> bool + Send + Sync>;

/// A window that has a document open, and the channel its updates go to.
#[derive(Clone)]
pub struct Subscriber {
    pub window_label: String,
    pub channel: Deliver,
}

/// One channel message. An update is its origin byte ([`origin_byte`]), then the bytes as they
/// were committed. The renderer applies every origin, 0 to 3, as `'remote'`, so its provider
/// sends none of them back; the byte only says where the update came from. A purge is the byte
/// [`PURGED`] alone: the window drops its copy and opens the document again. The typing
/// barrier's frames ([`BARRIER`], [`RELEASE`]) are the only others.
pub fn frame(notice: Notice<'_>) -> Vec<u8> {
    match notice {
        Notice::Update(update, origin) => {
            let mut frame = Vec::with_capacity(update.len() + 1);
            frame.push(origin_byte(origin));
            frame.extend_from_slice(update);
            frame
        }
        Notice::Purged => vec![PURGED],
    }
}

/// The frame of a purged document (a delete applied).
pub const PURGED: u8 = 4;

/// Why a window must not edit a document, as the open's answer names it to the renderer.
pub fn read_only_name(reason: ReadOnly) -> &'static str {
    match reason {
        ReadOnly::Locked => "locked",
        ReadOnly::LargeFile => "large-file",
        ReadOnly::Excluded => "excluded",
        ReadOnly::Database => "database-read-only",
    }
}

/// 0: another window's edit, 1: merged from the server, 2: an edit of the file outside the
/// app, 3: written by the app itself (a command, a repair, a restore).
pub fn origin_byte(origin: &Origin) -> u8 {
    match origin {
        Origin::Local(_) => 0,
        Origin::Remote => 1,
        Origin::External => 2,
        Origin::System => 3,
    }
}

#[derive(Debug, thiserror::Error)]
pub enum EditorHostError {
    /// No vault is open.
    #[error("no vault is open for editing")]
    NotServing,
    /// The window's editor belongs to a vault that is not the open one: note ids repeat across
    /// vaults, so its document must not bind here.
    #[error("the editor serves another vault")]
    OtherVault,
    /// The window has not opened the document in the vault served now: an editor left bound to
    /// a vault the user switched away from must not write into this one (note ids repeat across
    /// vaults). Electron drops these updates (`applyIpcUpdate`).
    #[error("{note_id} is not open in this window")]
    NotOpen { note_id: String },
    /// The editor needs the device identity, which the secure store did not give (a locked
    /// keychain). The next call tries again.
    #[error(transparent)]
    Identity(AuthError),
    #[error(transparent)]
    Editor(#[from] EditorError),
}

impl CoreError for EditorHostError {
    fn kind_and_code(&self) -> (FailureKind, &'static str) {
        match self {
            Self::NotServing => (FailureKind::Locked, "editor_not_serving"),
            Self::OtherVault => (FailureKind::Invalid, "editor_other_vault"),
            Self::NotOpen { .. } => (FailureKind::Invalid, "document_not_open"),
            Self::Identity(error) => error.kind_and_code(),
            Self::Editor(EditorError::NotFound { .. }) => (FailureKind::NotFound, "note_not_found"),
            Self::Editor(EditorError::Unreadable { .. }) => {
                (FailureKind::Crdt, "document_unreadable")
            }
            Self::Editor(EditorError::Purged { .. }) => (FailureKind::Crdt, "document_purged"),
            Self::Editor(EditorError::Locked { .. }) => (FailureKind::Locked, "note_locked"),
            Self::Editor(EditorError::Excluded { .. }) => (FailureKind::Locked, "note_excluded"),
            Self::Editor(EditorError::LargeFile { .. }) => {
                (FailureKind::Invalid, "note_large_file")
            }
            Self::Editor(EditorError::DatabaseReadOnly { .. }) => {
                (FailureKind::Storage, "database_read_only")
            }
            Self::Editor(EditorError::Crdt(error)) => error.kind_and_code(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_frame_is_the_origin_byte_then_the_update_and_a_purge_is_four() {
        let update = [9u8, 8];
        let framed = |origin: Origin| frame(Notice::Update(&update, &origin));
        assert_eq!(framed(Origin::Local("main".into())), [0, 9, 8]);
        assert_eq!(framed(Origin::Remote), [1, 9, 8]);
        assert_eq!(framed(Origin::External), [2, 9, 8]);
        assert_eq!(framed(Origin::System), [3, 9, 8]);
        assert_eq!(frame(Notice::Purged), [4]);
    }
}
