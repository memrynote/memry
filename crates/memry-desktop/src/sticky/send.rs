//! Sending sticky text where it belongs (`stickies/send.ts`): a note in the vault's `Sticky`
//! folder, a task, or a paragraph at the end of today's journal entry. A note or task send can
//! be undone for a minute ([`UndoLedger`]); the draft then comes back with the same text. The
//! command adapter that gates kinds, deletes the draft and remembers the kind is
//! `commands/sticky_send.rs` of `apps/desktop-tauri`.

use std::collections::HashMap;
use std::sync::{Mutex, PoisonError};

use memry_core::api::errors::StorageError;
use memry_core::domain::calendar::LocalDateTime;
use memry_core::domain::task_parse::quick_add::QuickAddProject;

use super::drafts::StickyKind;
use super::task_input::{TaskContext, task_input};
use super::text::split;
use crate::journal::update::DayUpdated;
use crate::notes::create::NewNoteFile;
use crate::notes::error::NotesError;
use crate::notes::folders;
use crate::notes::service::NotesService;
use crate::session::OpenVault;

/// Vault-relative folder for sticky notes. Not localized: two devices in different languages
/// share one vault and must land in the same folder.
pub const STICKY_FOLDER: &str = "Sticky";

/// How long Undo stays possible after a send. The sticky offers it only while its confirmation
/// shows; past that the created item may hold edits that an undo would delete.
const UNDO_WINDOW_MS: i64 = 60 * 1000;

/// What a send made: a note id, a task id, or the journal day (`YYYY-MM-DD`), and its title.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sent {
    pub target_id: String,
    pub title: String,
}

/// The local wall clock the task grammar and "today" read.
pub fn local_now() -> LocalDateTime {
    let now = chrono::Local::now().naive_local();
    LocalDateTime::parse(&now.format("%Y-%m-%dT%H:%M:%S").to_string())
        .expect("chrono formats a local instant LocalDateTime reads")
}

impl NotesService {
    /// A note titled by the first line, in [`STICKY_FOLDER`], made first when it is missing.
    pub fn send_sticky_note(&self, open: &OpenVault, content: &str) -> Result<Sent, NotesError> {
        let (title, body) = split(content);
        if !folders::list(open)?
            .iter()
            .any(|folder| folder.path == STICKY_FOLDER)
        {
            self.create_folder(open, STICKY_FOLDER)?;
        }
        let note = self.create(
            open,
            NewNoteFile {
                title: title.to_owned(),
                content: body.to_owned(),
                folder: Some(STICKY_FOLDER.to_owned()),
                ..Default::default()
            },
        )?;
        Ok(Sent {
            target_id: note.id,
            title: note.title,
        })
    }

    /// A task from the text ([`task_input`]), in the `+project` it names, else the user's
    /// default project while it is live, else the inbox.
    pub fn send_sticky_task(
        &self,
        open: &OpenVault,
        content: &str,
        default_project_id: Option<&str>,
        now: LocalDateTime,
    ) -> Result<Sent, NotesError> {
        let tasks = open.vault.tasks(self.store.clone())?;
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
        let input = task_input(
            content,
            &TaskContext {
                projects: &projects,
                default_project_id: default_project_id
                    .filter(|id| live.iter().any(|project| project.id == *id)),
                inbox_project_id: inbox,
                now,
            },
        );
        let title = input.title.clone();
        let change = tasks.create(input)?;
        let target_id = change.created.into_iter().next().ok_or_else(|| {
            NotesError::Storage(StorageError::Failed {
                what: "the task create answered no task id".to_owned(),
            })
        })?;
        Ok(Sent { target_id, title })
    }

    /// The text appended to the day `today` ([`NotesService::append_to_day`]).
    pub fn send_sticky_journal(
        &self,
        open: &OpenVault,
        content: &str,
        today: &str,
    ) -> Result<DayUpdated, NotesError> {
        self.append_to_day(open, today, content)
    }

    /// Takes back a note or task send: the note goes to the trash, the task is deleted.
    pub fn undo_sticky_send(&self, open: &OpenVault, undo: &Undo) -> Result<(), NotesError> {
        match undo.kind {
            StickyKind::Task => {
                open.vault
                    .tasks(self.store.clone())?
                    .delete(undo.target_id.clone(), false)?;
            }
            _ => self.delete(open, &undo.target_id, false)?,
        }
        Ok(())
    }
}

/// A send that can still be taken back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Undo {
    /// `Note` or `Task`: a journal append merges into a synced document and has no undo.
    pub kind: StickyKind,
    pub target_id: String,
    /// The text sent, which the restored draft gets.
    pub content: String,
    expires_at_ms: i64,
}

/// The sends of this run that can be undone, by token. Held in memory as Electron holds them: a
/// restart forgets them.
#[derive(Default)]
pub struct UndoLedger {
    entries: Mutex<HashMap<String, Undo>>,
}

impl UndoLedger {
    /// Holds a note or task send for [`UNDO_WINDOW_MS`]; `None` for a journal send.
    pub fn record(
        &self,
        kind: StickyKind,
        sent: &Sent,
        content: &str,
        now_ms: i64,
    ) -> Option<String> {
        if kind == StickyKind::Journal {
            return None;
        }
        let mut entries = self.entries.lock().unwrap_or_else(PoisonError::into_inner);
        entries.retain(|_, undo| undo.expires_at_ms > now_ms);
        let token = uuid::Uuid::new_v4().to_string();
        entries.insert(
            token.clone(),
            Undo {
                kind,
                target_id: sent.target_id.clone(),
                content: content.to_owned(),
                expires_at_ms: now_ms + UNDO_WINDOW_MS,
            },
        );
        Some(token)
    }

    /// The send of `token` while its window is open; each token is taken once.
    pub fn take(&self, token: &str, now_ms: i64) -> Option<Undo> {
        let mut entries = self.entries.lock().unwrap_or_else(PoisonError::into_inner);
        entries.retain(|_, undo| undo.expires_at_ms > now_ms);
        entries.remove(token)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sent() -> Sent {
        Sent {
            target_id: "n1".to_owned(),
            title: "Milk".to_owned(),
        }
    }

    #[test]
    fn an_undo_is_taken_once_within_its_minute() {
        let ledger = UndoLedger::default();
        let token = ledger
            .record(StickyKind::Note, &sent(), "Milk", 1_000)
            .unwrap();
        let undo = ledger.take(&token, 1_000 + UNDO_WINDOW_MS - 1).unwrap();
        assert_eq!(
            (undo.kind, undo.target_id.as_str(), undo.content.as_str()),
            (StickyKind::Note, "n1", "Milk")
        );
        assert_eq!(ledger.take(&token, 1_001), None);
    }

    #[test]
    fn an_undo_past_its_minute_is_gone() {
        let ledger = UndoLedger::default();
        let token = ledger
            .record(StickyKind::Task, &sent(), "Milk", 1_000)
            .unwrap();
        assert_eq!(ledger.take(&token, 1_000 + UNDO_WINDOW_MS), None);
    }

    #[test]
    fn a_journal_send_has_no_undo() {
        let ledger = UndoLedger::default();
        assert_eq!(
            ledger.record(StickyKind::Journal, &sent(), "Milk", 1_000),
            None
        );
    }
}
