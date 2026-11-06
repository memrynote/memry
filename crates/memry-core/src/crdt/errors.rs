//! The CRDT tier's error surface.
//!
//! Constitution II: a variant, never a rendered string. The three that matter
//! are genuinely different situations for a caller:
//!
//! - [`CrdtError::DocumentBusy`] is yrs refusing a transaction because another
//!   one is live. It is transient and the caller retries.
//! - [`CrdtError::Undecodable`] is bytes that are not a v1 update at all. It is
//!   permanent for those bytes, and it is what puts a document into the
//!   `Unreadable` state of data-model §C.4 rather than failing a call.
//! - [`CrdtError::Storage`] is the log, not the document.

use thiserror::Error;

use crate::api::errors::StorageError;

/// Failures of the CRDT tier (chapter 07, chapter 12 §12.5).
#[derive(Debug, Clone, PartialEq, Eq, Error, uniffi::Error)]
pub enum CrdtError {
    /// `yrs` could not hand out a transaction because another one is still
    /// alive on this document (`TransactionAcqError`).
    ///
    /// Every exported method here opens and closes its own transaction and none
    /// holds one across a call, so this means a concurrent caller, not a leak:
    /// it is transient and retryable (research R2).
    #[error("document {doc_id} is busy: {what}")]
    DocumentBusy { doc_id: String, what: String },

    /// Bytes that are not a decodable lib0 v1 update.
    ///
    /// Never the v2 codec: the protocol speaks v1 and only v1 (research R2).
    #[error("update for {doc_id} could not be decoded: {what}")]
    Undecodable { doc_id: String, what: String },

    /// A decodable update that `yrs` refused to integrate.
    #[error("update for {doc_id} could not be applied: {what}")]
    NotApplicable { doc_id: String, what: String },

    /// The note or journal day is locked ([`crate::domain::vault_locks`]): a
    /// write made on this device was refused before anything was written. The
    /// text is Electron's `VAULT_LOCKED_NOTE_MESSAGE`, which agents relay
    /// verbatim and the renderer localizes. Desktop's only, as the locks are:
    /// the iOS build and its Swift bindings have no such variant.
    #[cfg(feature = "markdown")]
    #[error("The owner made this note read-only.")]
    Locked { note_id: String },

    /// The durable log failed. Carries the storage variant rather than
    /// flattening it, so an out-of-space does not surface as "bad document".
    #[error("crdt storage failure: {source}")]
    Storage {
        #[from]
        source: StorageError,
    },
}
