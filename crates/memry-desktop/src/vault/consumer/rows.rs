//! The one lane that writes `note_files`. The consumer takes it for each watcher event; the
//! app's own file operations (Step 13's create, 12e-3's write-back) take it through
//! [`RowOwner`]'s methods. Either way a write checks [`PathIndex`] first and keeps it in step,
//! and the [`Applied`] fact goes out after the row is written, under the lane, so subscribers
//! see the facts in the order the rows changed.

use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use memry_core::api::errors::StorageError;
use memry_core::api::note_files::NoteFiles;
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

#[derive(Debug, thiserror::Error)]
pub enum RowError {
    #[error("no vault is open")]
    Closed,
    #[error(transparent)]
    Collision(#[from] PathCollision),
    #[error("note_files: {0}")]
    Storage(#[from] StorageError),
}

struct RowState {
    files: NoteFiles,
    index: PathIndex,
}

pub struct RowOwner {
    state: Mutex<Option<RowState>>,
    applied: broadcast::Sender<Applied>,
}

impl RowOwner {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(None),
            applied: broadcast::channel(APPLIED_CAPACITY).0,
        })
    }

    /// Every fact from the next one on. A subscriber reads the rows it needs; it never writes
    /// them and never decides a note's identity.
    pub fn subscribe(&self) -> broadcast::Receiver<Applied> {
        self.applied.subscribe()
    }

    pub(super) fn open(&self, files: NoteFiles) -> Result<(), StorageError> {
        let index = PathIndex::load(&files)?;
        *self.lock() = Some(RowState { files, index });
        Ok(())
    }

    pub(super) fn close(&self) {
        *self.lock() = None;
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

    /// The row of a note the app just created, before its file is written: the watcher's
    /// report of that file then finds the row and mints no second note.
    pub fn reserve(&self, note_id: &str, path: &str, stat: RowStat) -> Result<(), RowError> {
        let mut lane = self.lane()?;
        lane.put(note_id, path, stat)?;
        lane.publish(Applied::Added {
            note_id: note_id.to_owned(),
            path: path.to_owned(),
            created: true,
        });
        Ok(())
    }

    /// The app wrote the note's file.
    pub fn record_write(&self, note_id: &str, path: &str, stat: RowStat) -> Result<(), RowError> {
        let mut lane = self.lane()?;
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
    pub fn rename(&self, note_id: &str, new_path: &str) -> Result<bool, RowError> {
        let mut lane = self.lane()?;
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
    pub fn remove(&self, note_id: &str) -> Result<bool, RowError> {
        let mut lane = self.lane()?;
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
pub(super) struct Lane<'a> {
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

    pub(super) fn files(&self) -> &NoteFiles {
        &self.state().files
    }

    pub(super) fn row_at(&self, path: &str) -> Result<Option<Row>, StorageError> {
        self.files().by_path(path)
    }

    /// `Ok` when no note holds `path` under any spelling the volume may fold.
    pub(super) fn check_free(&self, path: &str) -> Result<(), PathCollision> {
        self.state().index.check("", path)
    }

    pub(super) fn put(&mut self, note_id: &str, path: &str, stat: RowStat) -> Result<(), RowError> {
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

    pub(super) fn publish(&self, fact: Applied) {
        // No subscriber is not an error: the facts are for whoever listens.
        let _ = self.applied.send(fact);
    }
}

pub(super) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}
