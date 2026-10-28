//! The one lane that writes `note_files`. The consumer takes it for each watcher event; the
//! app's own file operations (Step 13's create) take it through [`RowOwner`]'s methods, and the
//! write-back (`vault::writeback`) holds it for a whole pass. Either way a write checks [`PathIndex`] first and keeps it in step,
//! and the [`Applied`] fact goes out after the row is written, under the lane, so subscribers
//! see the facts in the order the rows changed.
//!
//! An app operation names the vault session it started in ([`RowSession`]): one that
//! finishes after its vault closed, or after another vault opened, writes nothing.
//!
//! Lock order: the lane, then the core's database writer (`call_blocking`). Never take the
//! lane from inside `call_blocking`, and never while holding a lock that a caller waiting on
//! the lane may hold. No `note_files` row is written anywhere else
//! (`tests::note_files_is_written_only_through_the_lane`).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use memry_core::api::errors::StorageError;
use memry_core::api::note_files::NoteFiles;
use memry_core::api::vault::Vault;
use memry_core::domain::note_files::{NoteFile as Row, NoteFileStat};
use tokio::sync::broadcast;

use super::{Applied, ChangeSource};
use crate::vault::file_types::{FileType, extension, mime_of_extension};
use crate::vault::path_key::{PathCollision, PathIndex};

/// Facts held for a subscriber that has not read them; past this it gets `Lagged` and runs
/// its own scan.
pub const APPLIED_CAPACITY: usize = 4096;

/// What a row records about its file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RowStat {
    pub file_type: FileType,
    pub size: u64,
    /// Markdown only, and only for content the note's document holds: a write-back reading
    /// a file that differs would take this hash for "the file is unchanged" and overwrite it.
    pub content_hash: Option<String>,
}

/// One open of one vault, as the rows know it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RowSession(u64);

#[derive(Debug, thiserror::Error)]
pub enum RowError {
    /// No vault is open, or not the session the operation started in.
    #[error("the vault session of this operation is closed")]
    Closed,
    #[error(transparent)]
    Collision(#[from] PathCollision),
    #[error("note_files: {0}")]
    Storage(#[from] StorageError),
}

struct RowState {
    session: RowSession,
    /// The open vault; a session is handed out only against this handle.
    vault: Arc<Vault>,
    files: NoteFiles,
    index: PathIndex,
}

pub struct RowOwner {
    state: Mutex<Option<RowState>>,
    applied: broadcast::Sender<Applied>,
    sessions: AtomicU64,
}

impl RowOwner {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(None),
            applied: broadcast::channel(APPLIED_CAPACITY).0,
            sessions: AtomicU64::new(0),
        })
    }

    /// Every fact from the next one on. A subscriber reads the rows it needs; it never writes
    /// them and never decides a note's identity.
    pub fn subscribe(&self) -> broadcast::Receiver<Applied> {
        self.applied.subscribe()
    }

    /// Opens the rows of `vault` under a new session, which every write of this open names.
    pub(crate) fn open(&self, vault: Arc<Vault>) -> Result<RowSession, StorageError> {
        let files = vault.note_files();
        let index = PathIndex::load(&files)?;
        let session = RowSession(self.sessions.fetch_add(1, Ordering::Relaxed) + 1);
        *self.lock() = Some(RowState {
            session,
            vault,
            files,
            index,
        });
        Ok(session)
    }

    /// The session of `vault`, the handle the operation works on (`OpenVault::vault` of the
    /// open it was handed): `Closed` unless that very vault is open. An app operation takes it
    /// when it starts and hands it to each row write, so a write for one vault never lands in
    /// another, nor in a later open of the same one.
    pub fn session_for(&self, vault: &Arc<Vault>) -> Result<RowSession, RowError> {
        self.lock()
            .as_ref()
            .filter(|state| Arc::ptr_eq(&state.vault, vault))
            .map(|state| state.session)
            .ok_or(RowError::Closed)
    }

    /// Closes the rows if `session` is still the open one; a close that runs late leaves a
    /// later open's rows alone.
    pub(crate) fn close_session(&self, session: RowSession) {
        let mut state = self.lock();
        if state.as_ref().is_some_and(|open| open.session == session) {
            *state = None;
        }
    }

    fn lock(&self) -> MutexGuard<'_, Option<RowState>> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub(super) fn lane(&self) -> Result<Lane<'_>, RowError> {
        let guard = self.lock();
        if guard.is_none() {
            return Err(RowError::Closed);
        }
        Ok(Lane {
            guard,
            applied: &self.applied,
        })
    }

    pub(crate) fn lane_of(&self, session: RowSession) -> Result<Lane<'_>, RowError> {
        let lane = self.lane()?;
        if lane.state().session != session {
            return Err(RowError::Closed);
        }
        Ok(lane)
    }

    /// The row of a note the app just created, before its file is written: the watcher's
    /// report of that file then finds the row and mints no second note.
    pub fn reserve(
        &self,
        session: RowSession,
        note_id: &str,
        path: &str,
        stat: RowStat,
    ) -> Result<(), RowError> {
        let mut lane = self.lane_of(session)?;
        lane.put(note_id, path, stat)?;
        lane.publish(Applied::Added {
            note_id: note_id.to_owned(),
            path: path.to_owned(),
            created: true,
        });
        Ok(())
    }

    /// The app wrote the note's file.
    pub fn record_write(
        &self,
        session: RowSession,
        note_id: &str,
        path: &str,
        stat: RowStat,
    ) -> Result<(), RowError> {
        let mut lane = self.lane_of(session)?;
        let content_hash = stat.content_hash.clone();
        lane.put(note_id, path, stat)?;
        lane.publish(Applied::Changed {
            note_id: note_id.to_owned(),
            path: path.to_owned(),
            content_hash,
            source: ChangeSource::App,
        });
        Ok(())
    }

    /// The app moved the note's file. `false` when the note has no row.
    pub fn rename(
        &self,
        session: RowSession,
        note_id: &str,
        new_path: &str,
    ) -> Result<bool, RowError> {
        let mut lane = self.lane_of(session)?;
        let Some(row) = lane.files().by_id(note_id)? else {
            return Ok(false);
        };
        lane.rename(note_id, new_path)?;
        lane.publish(Applied::Renamed {
            note_id: note_id.to_owned(),
            old_path: row.path,
            new_path: new_path.to_owned(),
        });
        Ok(true)
    }

    /// The app deleted the note (record first, then this). `false` when it had no row.
    pub fn remove(&self, session: RowSession, note_id: &str) -> Result<bool, RowError> {
        let mut lane = self.lane_of(session)?;
        let Some(row) = lane.files().by_id(note_id)? else {
            return Ok(false);
        };
        lane.remove(note_id)?;
        lane.publish(Applied::Removed {
            note_id: note_id.to_owned(),
            path: row.path,
        });
        Ok(true)
    }
}

/// The lane, held: one event's or one app operation's worth of row writes.
pub(crate) struct Lane<'a> {
    guard: MutexGuard<'a, Option<RowState>>,
    applied: &'a broadcast::Sender<Applied>,
}

impl Lane<'_> {
    fn state(&self) -> &RowState {
        self.guard
            .as_ref()
            .expect("a lane exists only while a vault is open")
    }

    fn state_mut(&mut self) -> &mut RowState {
        self.guard
            .as_mut()
            .expect("a lane exists only while a vault is open")
    }

    pub(crate) fn files(&self) -> &NoteFiles {
        &self.state().files
    }

    pub(super) fn row_at(&self, path: &str) -> Result<Option<Row>, StorageError> {
        self.files().by_path(path)
    }

    /// `Ok` when no note holds `path` under any spelling the volume may fold.
    pub(super) fn check_free(&self, path: &str) -> Result<(), PathCollision> {
        self.state().index.check("", path)
    }

    /// `Ok` when no other note holds `path`.
    pub(super) fn check(&self, note_id: &str, path: &str) -> Result<(), PathCollision> {
        self.state().index.check(note_id, path)
    }

    /// The row no longer names content the document holds.
    pub(super) fn forget_hash(&self, note_id: &str) -> Result<(), StorageError> {
        self.files().set_hash(note_id, None)
    }

    pub(crate) fn put(&mut self, note_id: &str, path: &str, stat: RowStat) -> Result<(), RowError> {
        let state = self.state_mut();
        state.index.check(note_id, path)?;
        state.files.upsert_stat(NoteFileStat {
            note_id: note_id.to_owned(),
            path: path.to_owned(),
            file_type: stat.file_type.as_str().to_owned(),
            mime_type: mime_of_extension(&extension(path)).map(str::to_owned),
            file_size: i64::try_from(stat.size).ok(),
            content_hash: stat.content_hash,
            indexed_at: now_ms(),
        })?;
        state.index.insert(note_id, path);
        Ok(())
    }

    pub(super) fn rename(&mut self, note_id: &str, new_path: &str) -> Result<(), RowError> {
        let state = self.state_mut();
        state.index.check(note_id, new_path)?;
        state.files.rename_path(note_id, new_path)?;
        state.index.insert(note_id, new_path);
        Ok(())
    }

    pub(super) fn remove(&mut self, note_id: &str) -> Result<(), RowError> {
        let state = self.state_mut();
        state.files.remove(note_id)?;
        state.index.remove_note(note_id);
        Ok(())
    }

    pub(crate) fn publish(&self, fact: Applied) {
        // No subscriber is not an error: the facts are for whoever listens.
        let _ = self.applied.send(fact);
    }
}

pub(super) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}
