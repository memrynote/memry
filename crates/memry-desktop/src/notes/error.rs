//! How a note operation fails (Step 13f, #3530), and the failure the shell turns it into.

use memry_core::api::errors::StorageError;

use crate::error::{CoreError, FailureKind};

pub(crate) const SCOPE: &str = "notes";

#[derive(Debug, thiserror::Error)]
pub enum NotesError {
    #[error("note not found: {0}")]
    NotFound(String),
    /// The note's file, or a folder on its path, resolves outside the vault.
    #[error("the note's file is outside the vault")]
    Outside,
    #[error(transparent)]
    Storage(#[from] StorageError),
    #[error("{0}")]
    Io(#[from] std::io::Error),
}

impl CoreError for NotesError {
    fn kind_and_code(&self) -> (FailureKind, &'static str) {
        match self {
            Self::NotFound(_) => (FailureKind::NotFound, "note_not_found"),
            Self::Outside => (FailureKind::Invalid, "outside_vault"),
            Self::Storage(error) => error.kind_and_code(),
            Self::Io(_) => (FailureKind::Storage, "note_file_failed"),
        }
    }
}
