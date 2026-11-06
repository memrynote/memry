//! The note and journal documents as editor windows reach them (Step 14b, #3531).
//!
//! Core's [`Editor`](memry_core::api::editor::Editor) keeps the resident documents, stores each
//! window's edit with its outbox row and hands every committed update to its listeners. This
//! module adds the windows: [`EditorHost`] serves the open vault's editor, keeps one
//! [`Subscriber`] per window and document, and sends each update to every subscriber but the
//! window that sent it, as a [`frame`]. A window that is gone lets go of everything it held
//! ([`EditorHost::forget_window`], Electron's `forgetWindow`).

mod host;

use std::sync::Arc;

use memry_core::api::editor::{EditorError, Notice, Origin};

pub use host::{EditorHealth, EditorHost, HostEvent};

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
/// were committed; the renderer applies origins 0 and 1 as `'remote'`, so its provider does not
/// send them back. A purge is the byte [`PURGED`] alone: the window drops its copy and opens the
/// document again.
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
    /// No vault is open, or its editor could not be built (the device has no identity).
    #[error("no vault is open for editing")]
    NotServing,
    /// The window's editor belongs to a vault that is not the open one: note ids repeat across
    /// vaults, so its document must not bind here.
    #[error("the editor serves another vault")]
    OtherVault,
    #[error(transparent)]
    Editor(#[from] EditorError),
}

impl CoreError for EditorHostError {
    fn kind_and_code(&self) -> (FailureKind, &'static str) {
        match self {
            Self::NotServing => (FailureKind::Locked, "editor_not_serving"),
            Self::OtherVault => (FailureKind::Invalid, "editor_other_vault"),
            Self::Editor(EditorError::NotFound { .. }) => (FailureKind::NotFound, "note_not_found"),
            Self::Editor(EditorError::Unreadable { .. }) => {
                (FailureKind::Crdt, "document_unreadable")
            }
            Self::Editor(EditorError::Crdt(error)) => error.kind_and_code(),
        }
    }
}
