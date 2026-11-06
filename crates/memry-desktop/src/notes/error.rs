//! How a note operation fails (Step 13f, #3530), and the failure the shell turns it into.

use memry_core::api::errors::{AuthError, StorageError};
use memry_core::crdt::errors::CrdtError;
use memry_core::domain::notes::app_move::BeginError;
use memry_core::markdown::frontmatter::YamlError;

use crate::error::{CoreError, FailureKind};
use crate::locks::Refused;
use crate::shell::file_open::OpenError;
use crate::vault::app_edit::{AppEditError, Kept};
use crate::vault::app_move::MoveError;
use crate::vault::consumer::rows::RowError;
use crate::vault::folder_file::FolderFileError;
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
    #[error("a note takes at most 50 tags of at most 50 characters each")]
    InvalidTags,
    /// A `notes:update` named a frontmatter key Memry writes through its own edit, `owner`.
    #[error("the frontmatter key `{key}` is written through {owner}, not notes_update")]
    ManagedKey {
        key: &'static str,
        owner: &'static str,
    },
    /// `NoteAliasEditSchema`: more names than a note holds, or a name too long to be one.
    #[error("an edit takes at most 32 other names of at most 200 characters each")]
    InvalidAliases,
    /// A move's folder is not one the vault's notes can be in: not a plain path of the vault,
    /// one the vault ignores (a dot folder, the root `attachments` folder, an exclude pattern),
    /// or a folder reached through a link.
    #[error("notes cannot be moved into that folder")]
    InvalidFolder,
    /// The note's last app move is not settled, or another version of the app recorded one.
    #[error(transparent)]
    MovePending(BeginError),
    /// The note's file holds text the note never read, and the OS trash refused it. The note
    /// is whole; the user decides whether it goes for good (#3813).
    #[error("the note's file could not be moved to the trash: {0}")]
    TrashUnavailable(String),
    /// A journal day's file is past the size the journal page reads whole (Step 13m); it is
    /// never cut.
    #[error("the day's file is larger than {0} bytes, which the journal does not open")]
    TooLarge(usize),
    /// A live day's text could not be written to its new file: it is not here yet, or the file
    /// would lose part of it. Nothing was written.
    #[error("the day's text cannot be written to its file yet: {0}")]
    DayTextUnwritable(String),
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
    /// The note's frontmatter is a list or a scalar, which has no keys to write.
    #[error("the note's frontmatter is not a set of keys, so it cannot be edited")]
    FrontmatterNotAMap,
    /// The note's frontmatter does not parse, so an edit would lose it (#3750).
    #[error("the note's frontmatter could not be read, so the edit was not made")]
    FrontmatterUnreadable,
    /// Only a markdown note's file holds a body and frontmatter to edit (`NOT_MARKDOWN`).
    #[error("only a markdown note can be edited")]
    NotMarkdown,
    /// The app's edit of the note's file was not made ([`Kept`]). Only an edit the file or the
    /// note's document has and the other does not have yet passes with a retry; the message says
    /// which. The variant is logged where the edit is refused, never shown.
    #[error("{}", kept_message(.0))]
    EditKept(Kept),
    /// The note or folder is locked: the operation was refused before anything was written.
    #[error("{}", .0.message())]
    Locked(Refused),
    #[error("the note has no property `{0}`")]
    PropertyNotFound(String),
    #[error("the note already has a property `{0}`")]
    PropertyExists(String),
    /// The folder to rename or move is not there (anymore): another window, a sync or a file
    /// manager moved it first (#2531).
    #[error("the folder is not there anymore")]
    FolderNotFound,
    /// The journal folder is, or is inside, the folder to delete.
    #[error("the folder holds the journal folder")]
    FolderHoldsJournal,
    /// The vault's settings file cannot be read, so they do not say where the journal is: a
    /// folder move or delete, or a day create, would act on the defaults instead.
    #[error("the vault settings file cannot be read: {0}")]
    SettingsUnreadable(String),
    /// A journal setting change a crash cut short still has days to put back, and the folder to
    /// move or delete is, holds or is inside one of its folders
    /// (`vault::journal_rename::finish_journal_change`).
    #[error("an earlier journal setting change did not finish; reopen the vault to finish it")]
    JournalChangeWaits,
    /// Journal days a journal folder moved outside the app carried wait for the setting to
    /// follow them, and the day or folder asked for would leave them outside the journal
    /// (`journal::folder_follow::Follow::HeldWaits`).
    #[error(
        "the journal folder was moved outside the app and its days wait for the setting to follow"
    )]
    JournalFolderHeld,
    /// The folder to delete is inside the journal folder (a year folder of a nested date
    /// format): it holds days, which a note delete does not take.
    #[error("the folder is inside the journal folder; delete its days in the journal")]
    FolderInJournal,
    /// The folder did not move, and what could not go back waits in `<name> (incomplete
    /// move)` beside it (`vault::move_dir`'s rollback). The message names the pattern, not the
    /// folder: command failures are logged with their message.
    #[error(
        "the folder did not move; files that could not go back are in the folder of its name \
         followed by “(incomplete move)”, beside it"
    )]
    FolderMoveIncomplete,
    #[error("template not found: {0}")]
    TemplateNotFound(String),
    /// A tag rename is running now.
    #[error("a rename of \"{from}\" to \"{to}\" is still running")]
    TagRenameInProgress { from: String, to: String },
    /// A tag merge, delete or removal from a note is running now, so another tag change waits
    /// (`errors:tag.editInProgress`).
    #[error("another tag change is still running")]
    TagEditInProgress,
    /// A merge of a tag into another name of itself (`errors:tag.mergeSameTag`).
    #[error("a tag is merged into another tag, not into itself")]
    TagMergeSameTag,
    /// Another tag rename is recorded with `left` notes it could not write; asking it again
    /// finishes it.
    #[error("renaming \"{from}\" to \"{to}\" did not finish for {left} notes")]
    TagRenameUnfinished {
        from: String,
        to: String,
        left: usize,
    },
    /// A folder's `.folder.md` cannot be read, so it is not written over, or cannot be
    /// written.
    #[error(transparent)]
    FolderFile(FolderFileError),
    #[error("{0}")]
    Io(#[from] std::io::Error),
}

impl NotesError {
    /// An app edit of a note's frontmatter the seam kept (`Edited::Kept`), as the property and
    /// alias writers answer it: nothing was written.
    pub(crate) fn kept(note_id: &str, kept: Kept) -> Self {
        match kept {
            Kept::NoRow | Kept::NoFile | Kept::NoBody => Self::NotFound(note_id.to_owned()),
            Kept::NotMarkdown => Self::NotMarkdown,
            Kept::FrontmatterUnreadable | Kept::FrontmatterBroken => Self::FrontmatterUnreadable,
            kept => Self::EditKept(kept),
        }
    }
}

/// Whether trying the edit again can succeed: the file or the document catches up on its own.
pub(crate) fn kept_is_retryable(kept: &Kept) -> bool {
    matches!(
        kept,
        Kept::FileChanged | Kept::NotRead | Kept::BodyAhead | Kept::FileAhead
    )
}

fn kept_message(kept: &Kept) -> &'static str {
    match kept {
        _ if kept_is_retryable(kept) => "the note changed while it was being edited; try again",
        Kept::FrontmatterUnreadable | Kept::FrontmatterBroken => {
            "the note's frontmatter could not be read, so the edit was not made"
        }
        Kept::BodyNotPulled => {
            "the note's text has not arrived from sync yet, so the edit was not made"
        }
        Kept::NotRepresentable => {
            "the note holds content its markdown file cannot, so the edit was not made"
        }
        Kept::NotMarkdown => "only a markdown note can be edited",
        // Electron's `VAULT_LOCKED_NOTE_MESSAGE`, as `CrdtError::Locked` says it.
        Kept::Locked => Refused::Note.message(),
        _ => "the note's file is not there, so the edit was not made",
    }
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

impl From<AppEditError> for NotesError {
    fn from(error: AppEditError) -> Self {
        match error {
            AppEditError::Rows(error) => error.into(),
            AppEditError::Storage(error) => Self::Storage(error),
            AppEditError::Crdt(error) => Self::Crdt(error),
            AppEditError::Auth(error) => Self::Auth(error),
            AppEditError::File(error) => Self::File(error),
        }
    }
}

impl From<BeginError> for NotesError {
    fn from(error: BeginError) -> Self {
        match error {
            BeginError::Storage(error) => Self::Storage(error),
            pending => Self::MovePending(pending),
        }
    }
}

impl From<MoveError> for NotesError {
    fn from(error: MoveError) -> Self {
        match error {
            MoveError::Begin(error) => error.into(),
            // A file took a folder's name after the move's own look (`moves::free_target`): the
            // folder is no folder of the vault. Windows says a folder below a file is not found;
            // elsewhere not found is the vault itself gone (a drive unplugged), an I/O failure.
            MoveError::Folder(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::AlreadyExists | std::io::ErrorKind::NotADirectory
                ) || (cfg!(windows) && error.kind() == std::io::ErrorKind::NotFound) =>
            {
                Self::InvalidFolder
            }
            MoveError::Io(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                Self::NameConflict
            }
            MoveError::Folder(error) | MoveError::Io(error) => Self::Io(error),
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
            Self::InvalidTags => (FailureKind::Invalid, "invalid_tags"),
            Self::InvalidAliases => (FailureKind::Invalid, "invalid_aliases"),
            Self::ManagedKey { .. } => (FailureKind::Invalid, "frontmatter_key_managed"),
            Self::InvalidFolder => (FailureKind::Invalid, "invalid_folder"),
            Self::MovePending(BeginError::Unreadable(_)) => {
                (FailureKind::Invalid, "note_move_unreadable")
            }
            Self::MovePending(BeginError::NotANote(_)) => (FailureKind::Invalid, "invalid_folder"),
            Self::MovePending(_) => (FailureKind::Invalid, "note_move_unsettled"),
            Self::TrashUnavailable(_) => (FailureKind::Storage, "note_trash_unavailable"),
            Self::TooLarge(_) => (FailureKind::Invalid, "journal_day_too_large"),
            Self::DayTextUnwritable(_) => (FailureKind::Invalid, "journal_day_unwritable"),
            Self::Crdt(error) => error.kind_and_code(),
            Self::Auth(error) => error.kind_and_code(),
            Self::File(_) => (FailureKind::Storage, "note_file_failed"),
            Self::Yaml(_)
            | Self::FrontmatterNotAMap
            | Self::FrontmatterUnreadable
            | Self::EditKept(Kept::FrontmatterUnreadable | Kept::FrontmatterBroken) => {
                (FailureKind::Invalid, "frontmatter_failed")
            }
            Self::NotMarkdown | Self::EditKept(Kept::NotMarkdown) => {
                (FailureKind::Invalid, "note_not_markdown")
            }
            Self::EditKept(kept) if kept_is_retryable(kept) => {
                (FailureKind::PropertyWrite, "note_edit_kept")
            }
            Self::EditKept(Kept::BodyNotPulled) => (FailureKind::Invalid, "note_body_not_pulled"),
            Self::EditKept(Kept::Locked) | Self::Locked(Refused::Note) => {
                (FailureKind::Locked, "note_locked")
            }
            Self::Locked(Refused::Folder) => (FailureKind::Locked, "folder_locked"),
            Self::EditKept(Kept::NotRepresentable) => {
                (FailureKind::Invalid, "note_not_representable")
            }
            Self::EditKept(_) => (FailureKind::NotFound, "note_not_found"),
            Self::PropertyNotFound(_) => (FailureKind::NotFound, "property_not_found"),
            Self::PropertyExists(_) => (FailureKind::PropertyWrite, "property_exists"),
            Self::TemplateNotFound(_) => (FailureKind::NotFound, "template_not_found"),
            Self::TagRenameInProgress { .. } => (FailureKind::Invalid, "tag_rename_in_progress"),
            Self::TagMergeSameTag => (FailureKind::Invalid, "tag_merge_same_tag"),
            Self::TagEditInProgress => (FailureKind::Invalid, "tag_edit_in_progress"),
            Self::TagRenameUnfinished { .. } => (FailureKind::Invalid, "tag_rename_unfinished"),
            Self::Outside => (FailureKind::Invalid, "outside_vault"),
            Self::Unopenable(Unopenable::HardLinked) => (FailureKind::Invalid, "note_hard_linked"),
            Self::Unopenable(Unopenable::NotRegular) => (FailureKind::Invalid, "note_not_regular"),
            Self::Unopenable(Unopenable::KeptChanging) => {
                (FailureKind::Storage, "note_kept_changing")
            }
            Self::Storage(error) => error.kind_and_code(),
            Self::FolderNotFound => (FailureKind::NotFound, "folder_not_found"),
            Self::FolderHoldsJournal => (FailureKind::Invalid, "folder_holds_journal"),
            Self::SettingsUnreadable(_) => (FailureKind::Invalid, "vault_settings_unreadable"),
            Self::FolderInJournal => (FailureKind::Invalid, "folder_in_journal"),
            Self::JournalChangeWaits => (FailureKind::Invalid, "journal_change_waits"),
            Self::JournalFolderHeld => (FailureKind::Invalid, "journal_folder_held"),
            Self::FolderMoveIncomplete => (FailureKind::Storage, "folder_move_incomplete"),
            Self::FolderFile(FolderFileError::Unreadable { .. }) => {
                (FailureKind::Invalid, "folder_file_unreadable")
            }
            Self::FolderFile(FolderFileError::Write { .. }) => {
                (FailureKind::Storage, "folder_file_failed")
            }
            Self::Io(_) => (FailureKind::Storage, "note_file_failed"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::file_move::FileMove;
    use crate::vault::watch::EchoGuard;

    /// A file where the new folder goes is a folder the note cannot be moved into, never a
    /// name another note holds.
    #[test]
    fn a_move_whose_folder_a_file_holds_fails_as_an_invalid_folder() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("a.md");
        std::fs::write(&source, "a note").unwrap();
        std::fs::write(dir.path().join("taken"), "a file").unwrap();
        for target in ["taken/a.md", "taken/deeper/a.md"] {
            let target = dir.path().join(target);
            let moved = FileMove {
                source: &source,
                target: &target,
                source_rel: "a.md",
                case_only: false,
            }
            .run(&EchoGuard::default());
            let error = NotesError::from(MoveError::from(moved.unwrap_err()));
            assert_eq!(error.kind_and_code().1, "invalid_folder", "{error:?}");
        }
        assert!(source.is_file());

        // Off Windows a folder that is not found is the vault gone, not a folder a file holds.
        let gone = MoveError::Folder(std::io::ErrorKind::NotFound.into());
        let expected = if cfg!(windows) {
            "invalid_folder"
        } else {
            "note_file_failed"
        };
        assert_eq!(NotesError::from(gone).kind_and_code().1, expected);
    }

    #[test]
    fn only_a_refusal_a_retry_can_pass_says_try_again_and_none_names_its_variant() {
        let all = [
            Kept::NoRow,
            Kept::NotMarkdown,
            Kept::NoFile,
            Kept::NotRead,
            Kept::FileChanged,
            Kept::FrontmatterUnreadable,
            Kept::FrontmatterBroken,
            Kept::BodyAhead,
            Kept::FileAhead,
            Kept::BodyNotPulled,
            Kept::NotRepresentable,
            Kept::NoBody,
            Kept::Locked,
        ];
        for kept in all {
            let variant = format!("{kept:?}");
            let error = NotesError::EditKept(kept);
            let message = error.to_string();
            let (_, code) = error.kind_and_code();
            assert_eq!(
                message.contains("try again"),
                code == "note_edit_kept",
                "{variant}"
            );
            assert!(!message.contains(&variant), "{message}");
        }
    }
}
