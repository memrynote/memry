//! How a note operation fails (Step 13f, #3530), and the failure the shell turns it into.

use memry_core::api::errors::{AuthError, StorageError};
use memry_core::crdt::errors::CrdtError;
use memry_core::markdown::frontmatter::YamlError;

use crate::error::{CoreError, FailureKind};
use crate::shell::file_open::OpenError;
use crate::vault::consumer::rows::RowError;
use crate::vault::note_file::NoteFileError;

pub(crate) const SCOPE: &str = "notes";

#[derive(Debug, thiserror::Error)]
pub enum NotesError {
    /// No vault is open, or the one the operation started in closed.
    #[error("no vault is open")]
    Closed,
    #[error("note not found: {0}")]
    NotFound(String),
    /// The note's file, or a folder on its path, resolves outside the vault.
    #[error("the note's file is outside the vault")]
    Outside,
    /// The note's file is there but is not one the app opens.
    #[error("{}", .0.message())]
    Unopenable(Unopenable),
    #[error("a file or a note already holds that name")]
    NameConflict,
    #[error("the title is empty or longer than 200 characters")]
    InvalidTitle,
    #[error(transparent)]
    Storage(#[from] StorageError),
    #[error(transparent)]
    Crdt(#[from] CrdtError),
    #[error(transparent)]
    Auth(#[from] AuthError),
    #[error(transparent)]
    File(#[from] NoteFileError),
    #[error("the frontmatter could not be written: {0}")]
    Yaml(#[from] YamlError),
    #[error("{0}")]
    Io(#[from] std::io::Error),
}

impl From<RowError> for NotesError {
    fn from(error: RowError) -> Self {
        match error {
            RowError::Closed => Self::Closed,
            RowError::Collision(_) => Self::NameConflict,
            RowError::Storage(error) => Self::Storage(error),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unopenable {
    /// Another name shares the file, so a write could land outside the vault.
    HardLinked,
    /// A folder, a device or a pipe stands where the note's file should be.
    NotRegular,
    /// The file kept changing while it was opened.
    KeptChanging,
}

impl Unopenable {
    fn message(self) -> &'static str {
        match self {
            Self::HardLinked => {
                "the note's file has another hard link, so the app does not open it; copy it \
                 to a new file"
            }
            Self::NotRegular => "the note's path is not a regular file",
            Self::KeptChanging => "the note's file kept changing while it was opened; try again",
        }
    }
}

impl From<OpenError> for NotesError {
    fn from(error: OpenError) -> Self {
        match error {
            OpenError::Outside => Self::Outside,
            OpenError::HardLinked => Self::Unopenable(Unopenable::HardLinked),
            OpenError::NotRegular => Self::Unopenable(Unopenable::NotRegular),
            OpenError::KeptChanging => Self::Unopenable(Unopenable::KeptChanging),
            OpenError::Io(error) => Self::Io(error),
        }
    }
}

impl CoreError for NotesError {
    fn kind_and_code(&self) -> (FailureKind, &'static str) {
        match self {
            Self::Closed => (FailureKind::Invalid, "no_vault_open"),
            Self::NotFound(_) => (FailureKind::NotFound, "note_not_found"),
            Self::NameConflict | Self::File(NoteFileError::AlreadyExists) => {
                (FailureKind::Invalid, "name_conflict")
            }
            Self::InvalidTitle => (FailureKind::Invalid, "invalid_title"),
            Self::Crdt(error) => error.kind_and_code(),
            Self::Auth(error) => error.kind_and_code(),
            Self::File(_) => (FailureKind::Storage, "note_file_failed"),
            Self::Yaml(_) => (FailureKind::Invalid, "frontmatter_failed"),
            Self::Outside => (FailureKind::Invalid, "outside_vault"),
            Self::Unopenable(Unopenable::HardLinked) => (FailureKind::Invalid, "note_hard_linked"),
            Self::Unopenable(Unopenable::NotRegular) => (FailureKind::Invalid, "note_not_regular"),
            Self::Unopenable(Unopenable::KeptChanging) => {
                (FailureKind::Storage, "note_kept_changing")
            }
            Self::Storage(error) => error.kind_and_code(),
            Self::Io(_) => (FailureKind::Storage, "note_file_failed"),
        }
    }
}
