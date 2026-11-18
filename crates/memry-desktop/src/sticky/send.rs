//! Sending sticky text where it belongs (`stickies/send.ts`): a note in the vault's `Sticky`
//! folder, a task, or a paragraph at the end of today's journal entry. A note or task send can
//! be undone for a minute ([`UndoLedger`]); the draft then comes back with the same text.
//! [`StickySend`] is the whole of `sendSticky` and `undoStickySend`: the kind's feature gate, the
//! target, the draft deleted once the text landed, the kind remembered for `defaultKind: 'last'`.
//! The command adapter that tells the windows is `commands/sticky_send.rs` of
//! `apps/desktop-tauri`.

use std::time::Duration;

use memry_core::api::errors::{AuthError, StorageError};
use memry_core::domain::calendar::LocalDateTime;
use memry_core::domain::task_parse::quick_add::QuickAddProject;
use serde_json::{Map, Value, json};

use super::drafts::{StickyDraft, StickyKind, StickyStore};
use super::task_input::{TaskContext, task_input};
use super::text::{cut_utf16, split};
pub use super::undo::{Undo, UndoLedger};
use crate::journal::update::DayUpdated;
use crate::notes::create::NewNoteFile;
use crate::notes::error::NotesError;
use crate::notes::folders::{Sibling, sibling_named};
use crate::notes::service::NotesService;
use crate::session::OpenVault;
use crate::settings::SettingsService;
use memry_core::domain::app_settings::SettingsChange;

/// Vault-relative folder for sticky notes. Not localized: two devices in different languages
/// share one vault and must land in the same folder.
pub const STICKY_FOLDER: &str = "Sticky";

/// `StickySendSchema`'s `content.max()`, in UTF-16 units.
const CONTENT_LIMIT: usize = 100_000;
/// A note title's limit (`NoteCreateSchema`), in UTF-16 units.
const NOTE_TITLE_LIMIT: usize = 200;
/// How long a journal send waits for an open editor's typing to reach the day's file.
const SETTLE: Duration = Duration::from_secs(2);

/// Why a send or an undo did not happen. Every variant but [`SendError::Notes`] is a refusal the
/// user reads (the renderer translates its [`SendError::code`]); nothing was written.
#[derive(Debug, thiserror::Error)]
pub enum SendError {
    #[error("there is no text to send")]
    Empty,
    #[error("sticky text takes at most 100000 characters")]
    TooLong,
    #[error("tasks are turned off in Settings")]
    TasksOff,
    #[error("the journal is turned off in Settings")]
    JournalOff,
    /// An open editor's typing was still being written to its file: retry in a moment.
    #[error("the journal entry is still saving")]
    JournalBusy,
    #[error("the Sticky folder is excluded from this vault")]
    FolderExcluded,
    /// The task's project, the inbox included, is not in this vault.
    #[error("the task's project does not exist")]
    ProjectMissing,
    #[error("the send can no longer be undone")]
    UndoExpired,
    #[error(transparent)]
    Notes(#[from] NotesError),
}

impl From<StorageError> for SendError {
    fn from(error: StorageError) -> Self {
        Self::Notes(error.into())
    }
}

impl From<AuthError> for SendError {
    fn from(error: AuthError) -> Self {
        Self::Notes(error.into())
    }
}

impl SendError {
    /// The refusal's error code, `None` for a failure of the write itself.
    pub fn code(&self) -> Option<&'static str> {
        Some(match self {
            Self::Empty => "sticky_empty",
            Self::TooLong => "sticky_too_long",
            Self::TasksOff => "sticky_tasks_off",
            Self::JournalOff => "sticky_journal_off",
            Self::JournalBusy => "sticky_journal_busy",
            Self::FolderExcluded => "sticky_folder_excluded",
            Self::ProjectMissing => "sticky_project_missing",
            Self::UndoExpired => "sticky_undo_expired",
            Self::Notes(_) => return None,
        })
    }
}

/// What a send made: a note id, a task id, or the journal day (`YYYY-MM-DD`), and its title.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sent {
    pub target_id: String,
    pub title: String,
}

/// `StickySendInput`.
#[derive(Debug, Clone)]
pub struct SendInput {
    /// The draft the text came from; deleted once the send lands.
    pub draft_id: Option<String>,
    pub content: String,
    pub kind: StickyKind,
}

/// A send that landed, and what the windows are to hear about it.
#[derive(Debug)]
pub struct Landed {
    pub kind: StickyKind,
    pub sent: Sent,
    /// `None` for a journal send, which has no undo.
    pub undo_token: Option<String>,
    /// The day a journal send wrote.
    pub day: Option<DayUpdated>,
    /// The draft list changed.
    pub draft_deleted: bool,
    /// `sticky.lastKind` was written.
    pub remembered: Option<SettingsChange>,
}

/// The local wall clock the task grammar and "today" read.
pub fn local_now() -> LocalDateTime {
    let now = chrono::Local::now().naive_local();
    LocalDateTime::parse(&now.format("%Y-%m-%dT%H:%M:%S").to_string())
        .expect("chrono formats a local instant LocalDateTime reads")
}

/// One send or undo over the open vault.
pub struct StickySend<'a> {
    pub notes: &'a NotesService,
    pub open: &'a OpenVault,
    pub settings: &'a SettingsService,
    pub drafts: &'a StickyStore,
    pub ledger: &'a UndoLedger,
}

impl StickySend<'_> {
    /// `sendSticky`: the text to its target, then the draft deleted and the kind remembered.
    pub fn send(
        &self,
        input: SendInput,
        now: LocalDateTime,
        now_ms: i64,
    ) -> Result<Landed, SendError> {
        if input.content.encode_utf16().count() > CONTENT_LIMIT {
            return Err(SendError::TooLong);
        }
        let content = input.content.trim();
        if content.is_empty() {
            return Err(SendError::Empty);
        }
        let kind = input.kind;
        self.enabled(kind)?;
        let (sent, day) = match kind {
            StickyKind::Note => (self.note(content)?, None),
            StickyKind::Task => (self.task(content, now)?, None),
            StickyKind::Journal => {
                let (sent, day) = self.journal(content, now)?;
                (sent, Some(day))
            }
        };
        // The text now lives in its target; only then does the draft go. A draft that stays is
        // logged, not a failed send: the user would send the text twice.
        let draft_deleted = input.draft_id.is_some_and(|id| {
            self.drafts.delete(id).unwrap_or_else(|error| {
                tracing::warn!(
                    scope = "StickySend",
                    "the sent draft could not be deleted: {error}"
                );
                false
            })
        });
        Ok(Landed {
            kind,
            undo_token: self.ledger.record(kind, &sent, content, now_ms),
            sent,
            day,
            draft_deleted,
            remembered: self.remember(kind),
        })
    }

    /// `undoStickySend`: the draft comes back first, then the note or task goes. A target that
    /// cannot be deleted takes the restored draft away again, so the text is in one place.
    pub fn undo(&self, token: &str, now_ms: i64) -> Result<StickyDraft, SendError> {
        let undo = self
            .ledger
            .take(token, now_ms)
            .ok_or(SendError::UndoExpired)?;
        let draft = self.drafts.save(None, undo.content.clone(), undo.kind)?;
        let deleted = match undo.kind {
            StickyKind::Task => self
                .open
                .vault
                .tasks(self.notes.store.clone())
                .map_err(SendError::from)
                .and_then(|tasks| Ok(tasks.delete(undo.target_id.clone(), false)?))
                .map(drop),
            _ => self
                .notes
                .delete(self.open, &undo.target_id, false)
                .map_err(SendError::from),
        };
        if let Err(error) = deleted {
            if let Err(cleanup) = self.drafts.delete(draft.id.clone()) {
                tracing::error!(
                    scope = "StickySend",
                    "an undo's restored draft stayed after the undo failed: {cleanup}"
                );
            }
            return Err(error);
        }
        Ok(draft)
    }

    fn group(&self, name: &str) -> Map<String, Value> {
        match self.settings.read_group(Some(self.open), name) {
            Ok(read) => read.value,
            Err(error) => {
                tracing::warn!(
                    scope = "StickySend",
                    "could not read the {name} settings: {error}"
                );
                Map::new()
            }
        }
    }

    /// `assertKindEnabled`: a task or journal send needs its feature on.
    fn enabled(&self, kind: StickyKind) -> Result<(), SendError> {
        let (feature, off) = match kind {
            StickyKind::Task => ("tasks", SendError::TasksOff),
            StickyKind::Journal => ("journal", SendError::JournalOff),
            StickyKind::Note => return Ok(()),
        };
        match self.group("features").get(feature).and_then(Value::as_bool) {
            Some(false) => Err(off),
            _ => Ok(()),
        }
    }

    /// `rememberStickyKind`. A failure is logged: the send already landed.
    fn remember(&self, kind: StickyKind) -> Option<SettingsChange> {
        if self.group("sticky").get("lastKind").and_then(Value::as_str) == Some(kind.as_str()) {
            return None;
        }
        let mut patch = Map::new();
        patch.insert("lastKind".to_owned(), json!(kind.as_str()));
        self.settings
            .write_group(Some(self.open), "sticky", patch)
            .inspect_err(|error| {
                tracing::warn!(
                    scope = "StickySend",
                    "could not remember the sticky kind: {error}"
                );
            })
            .ok()
    }

    /// `sendToNote`: titled by the first line, in [`STICKY_FOLDER`]. A first line longer than a
    /// title may be is cut for the title and kept whole at the top of the body.
    fn note(&self, content: &str) -> Result<Sent, SendError> {
        let folder = self.sticky_folder()?;
        let (first_line, rest) = split(content);
        let title = cut_utf16(first_line, NOTE_TITLE_LIMIT);
        let body = match (title.len() == first_line.len(), rest.is_empty()) {
            (true, _) => rest.to_owned(),
            (false, true) => first_line.to_owned(),
            (false, false) => format!("{first_line}\n{rest}"),
        };
        let note = self.notes.create(
            self.open,
            NewNoteFile {
                title: title.to_owned(),
                content: body,
                folder: Some(folder),
                ..Default::default()
            },
        )?;
        Ok(Sent {
            target_id: note.id,
            title: note.title,
        })
    }

    /// `ensureStickyFolder`: the folder as the disk spells it (`sticky/` made outside the app
    /// is the one), made when it is missing.
    fn sticky_folder(&self) -> Result<String, SendError> {
        let named = sibling_named(&self.open.path, STICKY_FOLDER).map_err(NotesError::from)?;
        let folder = match &named {
            Sibling::Named(name) => name.clone(),
            Sibling::Missing => STICKY_FOLDER.to_owned(),
            Sibling::Several => return Err(NotesError::NameConflict.into()),
        };
        if self.open.vault.excluded().covers(&folder) {
            return Err(SendError::FolderExcluded);
        }
        if matches!(named, Sibling::Missing) {
            self.notes.create_folder(self.open, &folder)?;
        }
        Ok(folder)
    }

    /// `sendToTask`: the `+project` it names, else the user's default project while it is
    /// live, else the inbox; a project the vault does not hold refuses it, as
    /// `PROJECT_MISSING_ERROR` does.
    fn task(&self, content: &str, now: LocalDateTime) -> Result<Sent, SendError> {
        let tasks = self.open.vault.tasks(self.notes.store.clone())?;
        let live = tasks.projects(false)?;
        let projects: Vec<QuickAddProject> = live
            .iter()
            .map(|project| QuickAddProject {
                id: project.id.clone(),
                name: project.name.clone(),
                is_archived: false,
            })
            .collect();
        let inbox = live
            .iter()
            .find(|project| project.is_inbox)
            .map_or("inbox", |project| project.id.as_str());
        let defaults = self.group("tasks");
        let default = defaults.get("defaultProjectId").and_then(Value::as_str);
        let input = task_input(
            content,
            &TaskContext {
                projects: &projects,
                default_project_id: default.filter(|id| live.iter().any(|p| p.id == *id)),
                inbox_project_id: inbox,
                now,
            },
        );
        if !live.iter().any(|project| project.id == input.project_id) {
            return Err(SendError::ProjectMissing);
        }
        let title = input.title.clone();
        let change = tasks.create(input)?;
        let target_id = change
            .created
            .into_iter()
            .next()
            .ok_or_else(|| StorageError::Failed {
                what: "the task create answered no task id".to_owned(),
            })?;
        Ok(Sent { target_id, title })
    }

    /// `sendToJournal`: a paragraph after today's text. The write-back of an open editor's
    /// typing runs first (`writebackNow`); one that does not finish refuses the send, so the
    /// append never goes over typing its file does not hold yet.
    fn journal(&self, content: &str, now: LocalDateTime) -> Result<(Sent, DayUpdated), SendError> {
        if !self.notes.tier.flush(SETTLE) {
            return Err(SendError::JournalBusy);
        }
        let today = now.date().key();
        let day = self.notes.append_to_day(self.open, &today, content)?;
        Ok((
            Sent {
                target_id: today.clone(),
                title: today,
            },
            day,
        ))
    }
}
