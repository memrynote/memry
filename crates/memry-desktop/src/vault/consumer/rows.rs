//! The one lane that writes `note_files`. The consumer takes it for each watcher event; the
//! app's own file operations (Step 13's create) take it through [`RowOwner`]'s methods, the
//! write-back (`vault::writeback`) holds it for a whole pass, a journal rename
//! (`vault::journal_rename`) for each file it moves, a note's rename or move in the app
//! (`notes::moves`) for the whole step, a folder's rename or move (`notes::folder_move`) for
//! the whole step too, and the vault open for the app move a crash cut short
//! (`vault::app_move`). Either way a write checks [`PathIndex`] first and keeps
//! it in step, and the [`Applied`] fact goes out after the row is written, under the lane, so
//! subscribers see the facts in the order the rows changed.
//!
//! An app operation names the vault session it started in ([`RowSession`]): one that
//! finishes after its vault closed, or after another vault opened, writes nothing.
//!
//! The lane is first come, first served ([`super::line`]): the consumer lets it go between two facts
//! or two files and asks again at once, and an app operation already waiting gets it first.
//!
//! Lock order: the lane, then the watcher's own-write record (`EchoGuard::removing`, inside
//! which a journal rename writes its row), then the core's database writer (`call_blocking`).
//! Never take the lane from inside `call_blocking`, and never while holding a lock that a
//! caller waiting on the lane may hold. No `note_files` row is written anywhere else
//! (`tests::note_files_is_written_only_through_the_lane`).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};
use std::time::{SystemTime, UNIX_EPOCH};

use memry_core::api::errors::StorageError;
use memry_core::api::note_files::NoteFiles;
use memry_core::api::notes_write::NotesWriter;
use memry_core::api::vault::Vault;
use memry_core::domain::note_files::{NoteFile as Row, NoteFileStat, StampMark};
use memry_core::domain::notes::app_move::{AppMoved, BeginError};
use tokio::sync::broadcast;

use super::line::{Line, Turn};
use super::{Applied, ChangeSource, MoveKind};
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
    line: Line,
    applied: broadcast::Sender<Applied>,
    sessions: AtomicU64,
    /// The vault whose consumer's walk ended complete, with every folder listed, and whose files
    /// it found all have a row: none failed, or each one's retry landed. Cleared when a consumer
    /// starts, so an exclude pattern's restart walks again first. Apart from `state`, so a reader
    /// does not wait for the lane.
    walked: Mutex<Weak<Vault>>,
}

impl RowOwner {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(None),
            line: Line::default(),
            applied: broadcast::channel(APPLIED_CAPACITY).0,
            sessions: AtomicU64::new(0),
            walked: Mutex::new(Weak::new()),
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

    /// Whether the walk of `vault`, the handle of the open being asked about, gave every file it
    /// found a row (`walked`). Until then a file on disk may have no row, so the rows are not the
    /// vault. A file written after the walk and not yet reported by the watcher is still unseen.
    pub fn walked(&self, vault: &Arc<Vault>) -> bool {
        let walked = self.walked.lock().unwrap_or_else(PoisonError::into_inner);
        std::ptr::eq(walked.as_ptr(), Arc::as_ptr(vault))
    }

    fn lock(&self) -> MutexGuard<'_, Option<RowState>> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub(super) fn lane(&self) -> Result<Lane<'_>, RowError> {
        let turn = self.line.wait();
        let guard = self.lock();
        if guard.is_none() {
            return Err(RowError::Closed);
        }
        Ok(Lane {
            guard,
            _turn: turn,
            applied: &self.applied,
            walked: &self.walked,
        })
    }

    /// The takers waiting for the lane behind its holder.
    #[cfg(test)]
    pub(crate) fn waiting(&self) -> u64 {
        self.line.waiting()
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
            source: ChangeSource::App,
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
            kind: MoveKind::Renamed,
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
            source: ChangeSource::App,
        });
        Ok(true)
    }
}

/// The lane, held: one event's or one app operation's worth of row writes.
pub(crate) struct Lane<'a> {
    guard: MutexGuard<'a, Option<RowState>>,
    /// Dropped after `guard`: the next in line takes the rows once they are free.
    _turn: Turn<'a>,
    applied: &'a broadcast::Sender<Applied>,
    walked: &'a Mutex<Weak<Vault>>,
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
    pub(crate) fn record_file_hash(
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
        self.put_as_of(note_id, path, stat, (now_ms(), StampMark::Now))
    }

    /// [`Lane::put`] stamped `at` with its log mark: a time and a mark taken before the caller
    /// read the body and the file it records (the write-back's stamp, `vault::writeback`), or
    /// the stamp the row had, kept ([`StampMark::Kept`]).
    pub(crate) fn put_as_of(
        &mut self,
        note_id: &str,
        path: &str,
        stat: RowStat,
        (at, mark): (i64, StampMark),
    ) -> Result<(), RowError> {
        let state = self.state_mut();
        state.index.check(note_id, path)?;
        state
            .files
            .upsert_stat_as(file_stat(note_id, path, stat, at), mark)?;
        state.index.insert(note_id, path);
        Ok(())
    }

    /// [`Lane::put`] of many notes' rows at once, all or none, in one transaction: the new
    /// notes the consumer created together. The caller hands in paths no two of which a
    /// volume folds together.
    pub(crate) fn put_all(&mut self, rows: Vec<(String, String, RowStat)>) -> Result<(), RowError> {
        let at = now_ms();
        let state = self.state_mut();
        let mut stats = Vec::with_capacity(rows.len());
        for (note_id, path, stat) in rows {
            state.index.check(&note_id, &path)?;
            stats.push(file_stat(&note_id, &path, stat, at));
        }
        state.files.upsert_stats(&stats)?;
        for stat in &stats {
            state.index.insert(&stat.note_id, &stat.path);
        }
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
        state
            .files
            .refresh_stat(file_stat(note_id, path, stat, now_ms()))?;
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
    /// leaves all three where they were. Publishes no fact: the live move
    /// (`notes::moves`) publishes [`Applied::Renamed`] itself, and the vault open's finish
    /// (`vault::app_move`) runs before the walk, whose end the note index answers with a scan.
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

    /// The app moved the folder `from` to `to` with the notes of `moves` (Step 13h): their
    /// records and rows, the folder's records and its manual order follow in one core
    /// transaction ([`NotesWriter::folder_moved_by_app`]); an `Err` leaves all of it where it
    /// was. Publishes no fact, as [`Lane::move_by_app`].
    pub(crate) fn folder_moved_by_app(
        &mut self,
        writer: &NotesWriter,
        from: &str,
        to: &str,
        moves: &[(&str, AppMoved<'_>)],
    ) -> Result<(), RowError> {
        let state = self.state_mut();
        for (note_id, moved) in moves {
            state.index.check(note_id, moved.new_path)?;
        }
        writer.folder_moved_by_app(from, to, moves)?;
        for (note_id, moved) in moves {
            state.index.insert(note_id, moved.new_path);
        }
        Ok(())
    }

    /// [`Lane::begin_move`] for a folder the app moves and every note in it, all or none
    /// ([`NotesWriter::begin_folder_move`]).
    pub(crate) fn begin_folder_move(
        &mut self,
        writer: &NotesWriter,
        from: &str,
        to: &str,
        moves: &[(&str, AppMoved<'_>)],
    ) -> Result<(), BeginError> {
        writer.begin_folder_move(from, to, moves)
    }

    /// Records the app's delete of the folder at `path` ([`NotesWriter::begin_folder_delete`]).
    /// Writes no row: `&mut self` is only the proof that the lane is held.
    pub(crate) fn begin_folder_delete(
        &mut self,
        writer: &NotesWriter,
        path: &str,
        note_ids: &[&str],
    ) -> Result<(), BeginError> {
        writer.begin_folder_delete(path, note_ids)
    }

    /// Forgets the record of the folder's delete ([`NotesWriter::abandon_folder_delete`]).
    pub(crate) fn forget_folder_delete(
        &mut self,
        writer: &NotesWriter,
        path: &str,
    ) -> Result<bool, StorageError> {
        writer.abandon_folder_delete(path)
    }

    /// The folder at `path` left the disk with the notes `note_ids`: their records, their rows,
    /// the folder's records and its order go in one transaction
    /// ([`NotesWriter::folder_deleted_by_app`]), and the index forgets the notes.
    pub(crate) fn folder_deleted_by_app(
        &mut self,
        writer: &NotesWriter,
        path: &str,
        note_ids: &[&str],
    ) -> Result<(), RowError> {
        writer.folder_deleted_by_app(path, note_ids)?;
        let state = self.state_mut();
        for note_id in note_ids {
            state.index.remove_note(note_id);
        }
        Ok(())
    }

    /// Forgets the folder's record of an app move ([`NotesWriter::abandon_folder_move`]),
    /// under the lane as [`Lane::forget_move`].
    pub(crate) fn forget_folder_move(
        &mut self,
        writer: &NotesWriter,
        from: &str,
        to: &str,
    ) -> Result<bool, StorageError> {
        writer.abandon_folder_move(from, to)
    }

    /// Records the note's app move before its file moves ([`NotesWriter::begin_app_move`]).
    /// Writes no row: `&mut self` is only the proof that the lane is held.
    pub(crate) fn begin_move(
        &mut self,
        writer: &NotesWriter,
        note_id: &str,
        moved: AppMoved<'_>,
    ) -> Result<(), BeginError> {
        writer.begin_app_move(note_id, moved)
    }

    /// Forgets the note's record of an app move ([`NotesWriter::abandon_app_move`]). Under the
    /// lane, as the move it records and its [`NotesWriter::begin_app_move`], so a note has one
    /// move at a time. Writes no row: `&mut self` is only the proof that the lane is held.
    pub(crate) fn forget_move(
        &mut self,
        writer: &NotesWriter,
        note_id: &str,
        old_path: &str,
        new_path: &str,
    ) -> Result<bool, StorageError> {
        writer.abandon_app_move(note_id, old_path, new_path)
    }

    pub(crate) fn remove(&mut self, note_id: &str) -> Result<(), RowError> {
        let state = self.state_mut();
        state.files.remove(note_id)?;
        state.index.remove_note(note_id);
        Ok(())
    }

    /// Records whether every file the consumer's walk found has a row ([`RowOwner::walked`]).
    pub(crate) fn set_walked(&self, walked: bool) {
        *self.walked.lock().unwrap_or_else(PoisonError::into_inner) = if walked {
            Arc::downgrade(&self.state().vault)
        } else {
            Weak::new()
        };
    }

    pub(crate) fn publish(&self, fact: Applied) {
        // No subscriber is not an error: the facts are for whoever listens.
        let _ = self.applied.send(fact);
    }
}

/// The row of `note_id` at `path` as `stat` describes its file, stamped `at`.
fn file_stat(note_id: &str, path: &str, stat: RowStat, at: i64) -> NoteFileStat {
    NoteFileStat {
        note_id: note_id.to_owned(),
        path: path.to_owned(),
        file_type: stat.file_type.as_str().to_owned(),
        mime_type: mime_of_extension(&extension(path)).map(str::to_owned),
        file_size: i64::try_from(stat.size).ok(),
        content_hash: stat.content_hash,
        file_hash: stat.file_hash,
        indexed_at: at,
    }
}

pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}
