//! The one lane that writes `note_files`. The consumer takes it for each watcher event; the
//! app's own file operations (Step 13's create) take it through [`RowOwner`]'s methods, the
//! write-back (`vault::writeback`) holds it for a whole pass, a journal rename
//! (`vault::journal_rename`) for each file it moves, and the vault open for the app move a
//! crash cut short (`vault::app_move`). Either way a write checks [`PathIndex`] first and keeps
//! it in step, and the [`Applied`] fact goes out after the row is written, under the lane, so
//! subscribers see the facts in the order the rows changed.
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
use memry_core::api::notes_write::NotesWriter;
use memry_core::api::vault::Vault;
use memry_core::domain::note_files::{NoteFile as Row, NoteFileStat};
use memry_core::domain::notes::app_move::AppMoved;
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
    /// Markdown only: the hash of the bytes read, whether or not the document took them. A
    /// move made while the app was closed pairs on it (`vault::watch::rename`).
    pub file_hash: Option<String>,
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

    pub(crate) fn row_at(&self, path: &str) -> Result<Option<Row>, StorageError> {
        self.files().by_path(path)
    }

    /// `Ok` when no note holds `path` under any spelling the volume may fold.
    pub(crate) fn check_free(&self, path: &str) -> Result<(), PathCollision> {
        self.state().index.check("", path)
    }

    /// `Ok` when no other note holds `path`.
    pub(crate) fn check(&self, note_id: &str, path: &str) -> Result<(), PathCollision> {
        self.state().index.check(note_id, path)
    }

    /// The note's file went and its row stays: the row names no content the document holds,
    /// and no bytes on disk, so no file pairs with it as its move.
    pub(super) fn forget_hash(&self, note_id: &str) -> Result<(), StorageError> {
        self.files().set_hash(note_id, None)
    }

    /// The file was read, or found unreadable, and its text not taken: only its pairing hash
    /// moves, to the bytes on disk now or to none. The row's size, stamp and content hash stay
    /// those of what the document holds, which the write-back compares with; the walk then
    /// reads the file again at every open, as it did before file hashes.
    pub(super) fn record_file_hash(
        &self,
        note_id: &str,
        hash: Option<&str>,
    ) -> Result<(), StorageError> {
        self.files().set_file_hash(note_id, hash)
    }

    /// Records the row stamped now: the caller read the file now and, with a hash, the body
    /// holds it now (a feed that just took it). The stamp's one meaning is
    /// `memry_core::domain::note_files::NoteFile::indexed_at`. It is taken after the feed's
    /// commit and before this write's hop to the database writer: an app edit committed in
    /// between is stamped before the row and is not seen behind, so only a crash in those
    /// milliseconds, before that edit's own pass, leaves its file lagging. A stamp taken before
    /// the feed would instead put the feed's own commit after it, and every fed note behind.
    pub(crate) fn put(&mut self, note_id: &str, path: &str, stat: RowStat) -> Result<(), RowError> {
        self.put_as_of(note_id, path, stat, now_ms())
    }

    /// [`Lane::put`] stamped `at`: a time before the caller read the body and the file it
    /// records (the write-back's stamp, `vault::writeback`).
    pub(crate) fn put_as_of(
        &mut self,
        note_id: &str,
        path: &str,
        stat: RowStat,
        at: i64,
    ) -> Result<(), RowError> {
        let state = self.state_mut();
        state.index.check(note_id, path)?;
        state.files.upsert_stat(NoteFileStat {
            note_id: note_id.to_owned(),
            path: path.to_owned(),
            file_type: stat.file_type.as_str().to_owned(),
            mime_type: mime_of_extension(&extension(path)).map(str::to_owned),
            file_size: i64::try_from(stat.size).ok(),
            content_hash: stat.content_hash,
            file_hash: stat.file_hash,
            indexed_at: at,
        })?;
        state.index.insert(note_id, path);
        Ok(())
    }

    /// The file was read again and is the bytes its row names, which says nothing of the body:
    /// the stamp moves to now only while the body has not moved since it
    /// (`memry_core::domain::note_files::refresh_stat`), so a note behind its body stays so.
    pub(super) fn refresh(
        &mut self,
        note_id: &str,
        path: &str,
        stat: RowStat,
    ) -> Result<(), RowError> {
        let state = self.state_mut();
        state.index.check(note_id, path)?;
        state.files.refresh_stat(NoteFileStat {
            note_id: note_id.to_owned(),
            path: path.to_owned(),
            file_type: stat.file_type.as_str().to_owned(),
            mime_type: mime_of_extension(&extension(path)).map(str::to_owned),
            file_size: i64::try_from(stat.size).ok(),
            content_hash: stat.content_hash,
            file_hash: stat.file_hash,
            indexed_at: now_ms(),
        })?;
        state.index.insert(note_id, path);
        Ok(())
    }

    pub(crate) fn rename(&mut self, note_id: &str, new_path: &str) -> Result<(), RowError> {
        let state = self.state_mut();
        state.index.check(note_id, new_path)?;
        state.files.rename_path(note_id, new_path)?;
        state.index.insert(note_id, new_path);
        Ok(())
    }

    /// The app moved the note's file (Step 13g): the record, this row and the note's manual
    /// slot follow it in one core transaction ([`NotesWriter::moved_by_app`]), so an `Err`
    /// leaves all three where they were.
    pub(crate) fn move_by_app(
        &mut self,
        writer: &NotesWriter,
        note_id: &str,
        moved: AppMoved<'_>,
    ) -> Result<(), RowError> {
        let state = self.state_mut();
        state.index.check(note_id, moved.new_path)?;
        writer.moved_by_app(note_id, moved)?;
        state.index.insert(note_id, moved.new_path);
        Ok(())
    }

    pub(crate) fn remove(&mut self, note_id: &str) -> Result<(), RowError> {
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

pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}
