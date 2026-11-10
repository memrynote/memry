//! Read-only locks on notes and folders (desktop Step 14e, #3531), the port of
//! Electron's `vault-locks/{registry,store}.ts` over the `vault_locks` table
//! (migration 22).
//!
//! A lock stops edits made on this device. A note lock is keyed by the note id,
//! so it follows the note through a rename or move; a folder lock is keyed by
//! the folder's vault-relative path and covers everything under it. A note is
//! locked by its own lock or by a lock on any folder above its file
//! (`note_files.path`). Rows of a kind this build does not know, unlocked rows
//! and tombstoned rows lock nothing.
//!
//! The rows carry no clock and get no outbox row yet: the `vault_lock`
//! projector and handler (Step 16, #3533) add both, so these rows are the
//! records that sync then carries.
//!
//! Beside them, the device-local rows the desktop lock guard keeps, never synced:
//! each locked markdown note's [`Baseline`] and each locked file's [`FileMode`]
//! (`vault_lock_baselines`, `vault_lock_file_modes`, Electron's `store.ts`).

use rusqlite::{Connection, OptionalExtension, params};

use crate::api::errors::StorageError;
use crate::domain::notes::journal_day::body_owner;

/// What a lock covers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TargetKind {
    /// One note or journal day, by id.
    Note,
    /// A folder and everything under it, by vault-relative path.
    Folder,
}

impl TargetKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Note => "note",
            Self::Folder => "folder",
        }
    }
}

/// The record id of a lock: two devices locking one target share one record.
pub fn lock_id(kind: TargetKind, target: &str) -> String {
    format!("{}:{target}", kind.as_str())
}

/// `a/b/`, `/a/b` and `a\b` all name the folder `a/b`.
pub fn normalize_folder_path(path: &str) -> String {
    path.replace('\\', "/").trim_matches('/').to_owned()
}

/// Every target locked on this device.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LockState {
    /// Note and journal day ids.
    pub notes: Vec<String>,
    /// Normalized vault-relative folder paths.
    pub folders: Vec<String>,
}

/// What [`set`] wrote.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SetOutcome {
    /// A new lock row, or a tombstoned one locked again.
    Created,
    /// The row's `locked` flipped.
    Updated,
    /// Nothing: the target already was in that state, or an unlock of a target
    /// that was never locked.
    Unchanged,
}

/// Locks or unlocks a note (by id) or a folder (by vault-relative path).
/// Unlocking keeps the row with `locked` 0. A note must be a live note or
/// journal day, and a folder path must not be empty; whether the folder exists
/// on disk is the shell's to check.
pub fn set(
    conn: &Connection,
    kind: TargetKind,
    target: &str,
    locked: bool,
    now_ms: i64,
) -> Result<SetOutcome, StorageError> {
    let target = match kind {
        TargetKind::Note => target.to_owned(),
        TargetKind::Folder => normalize_folder_path(target),
    };
    match kind {
        TargetKind::Note if body_owner(conn, &target)?.is_none() => {
            return Err(StorageError::NotFound {
                what: format!("note {target}"),
            });
        }
        TargetKind::Folder if target.is_empty() => {
            return Err(StorageError::Invalid {
                what: "a folder lock needs a folder path".to_owned(),
            });
        }
        _ => {}
    }
    let id = lock_id(kind, &target);
    let live: Option<bool> = conn
        .query_row(
            "SELECT locked FROM vault_locks WHERE id = ?1 AND deleted_at IS NULL",
            params![id],
            |row| row.get(0),
        )
        .optional()
        .map_err(failed)?;
    match live {
        Some(current) if current == locked => Ok(SetOutcome::Unchanged),
        Some(_) => {
            conn.execute(
                "UPDATE vault_locks SET locked = ?2, updated_at = ?3 WHERE id = ?1",
                params![id, locked, now_ms],
            )
            .map_err(failed)?;
            Ok(SetOutcome::Updated)
        }
        None if !locked => Ok(SetOutcome::Unchanged),
        None => {
            conn.execute(
                "INSERT INTO vault_locks (id, target_kind, target, locked, created_at, updated_at)
                 VALUES (?1, ?2, ?3, 1, ?4, ?4)
                 ON CONFLICT (id) DO UPDATE SET
                   target_kind = excluded.target_kind, target = excluded.target, locked = 1,
                   created_at = excluded.created_at, updated_at = excluded.updated_at,
                   deleted_at = NULL",
                params![id, kind.as_str(), target, now_ms],
            )
            .map_err(failed)?;
            Ok(SetOutcome::Created)
        }
    }
}

/// Every locked note and folder, in the order they were first locked.
pub fn list(conn: &Connection) -> Result<LockState, StorageError> {
    Ok(LockState {
        notes: locked_targets(conn, TargetKind::Note)?,
        folders: locked_folders(conn)?,
    })
}

/// The locked folder that covers `relative_path`: the path itself or a folder
/// above it.
pub fn folder_covering(
    conn: &Connection,
    relative_path: &str,
) -> Result<Option<String>, StorageError> {
    let path = normalize_folder_path(relative_path);
    Ok(locked_folders(conn)?
        .into_iter()
        .find(|folder| is_under(&path, folder)))
}

/// Whether `note_id` is locked by its own lock or by a folder above its file.
/// `note_path` is the note's vault-relative path when the caller has it;
/// otherwise its `note_files` row gives it, and a note with no file row is
/// covered by no folder.
pub fn is_note_locked(
    conn: &Connection,
    note_id: &str,
    note_path: Option<&str>,
) -> Result<bool, StorageError> {
    let own: bool = conn
        .query_row(
            "SELECT EXISTS (SELECT 1 FROM vault_locks
             WHERE target_kind = 'note' AND target = ?1 AND locked = 1 AND deleted_at IS NULL)",
            params![note_id],
            |row| row.get(0),
        )
        .map_err(failed)?;
    if own {
        return Ok(true);
    }
    let folders = locked_folders(conn)?;
    if folders.is_empty() {
        return Ok(false);
    }
    let path = match note_path {
        Some(path) => Some(path.to_owned()),
        None => conn
            .query_row(
                "SELECT path FROM note_files WHERE note_id = ?1",
                params![note_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(failed)?,
    };
    Ok(path.is_some_and(|path| {
        let path = normalize_folder_path(&path);
        folders.iter().any(|folder| is_under(&path, folder))
    }))
}

/// A locked markdown note's text as the app last wrote or accepted it: what an
/// outside edit of its file is reverted to. Device-local, never synced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Baseline {
    pub content: String,
    /// The shell's hash of `content`, which it compares a changed file against.
    pub content_hash: String,
    /// Epoch milliseconds.
    pub updated_at: i64,
}

/// The permission bits a file had before a lock made it read-only, and the
/// file they belong to (`None`: not known yet). Device-local, never synced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileMode {
    pub mode: u32,
    pub identity: Option<String>,
}

/// `note_id`'s baseline, if it has one.
pub fn baseline(conn: &Connection, note_id: &str) -> Result<Option<Baseline>, StorageError> {
    conn.query_row(
        "SELECT content, content_hash, updated_at FROM vault_lock_baselines WHERE note_id = ?1",
        params![note_id],
        |row| {
            Ok(Baseline {
                content: row.get(0)?,
                content_hash: row.get(1)?,
                updated_at: row.get(2)?,
            })
        },
    )
    .optional()
    .map_err(failed)
}

/// Makes `content` the note's baseline, replacing any it had.
pub fn write_baseline(
    conn: &Connection,
    note_id: &str,
    content: &str,
    content_hash: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    conn.execute(
        "INSERT INTO vault_lock_baselines (note_id, content_hash, content, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (note_id) DO UPDATE SET
           content_hash = excluded.content_hash, content = excluded.content,
           updated_at = excluded.updated_at",
        params![note_id, content_hash, content, now_ms],
    )
    .map(drop)
    .map_err(failed)
}

/// Drops the note's baseline: its lock is gone, or the note is.
pub fn delete_baseline(conn: &Connection, note_id: &str) -> Result<(), StorageError> {
    conn.execute(
        "DELETE FROM vault_lock_baselines WHERE note_id = ?1",
        params![note_id],
    )
    .map(drop)
    .map_err(failed)
}

/// Every note that has a baseline.
pub fn baseline_note_ids(conn: &Connection) -> Result<Vec<String>, StorageError> {
    let mut statement = conn
        .prepare_cached("SELECT note_id FROM vault_lock_baselines ORDER BY rowid")
        .map_err(failed)?;
    statement
        .query_map([], |row| row.get(0))
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)
}

/// The recorded mode of the file at vault-relative `path`.
pub fn file_mode(conn: &Connection, path: &str) -> Result<Option<FileMode>, StorageError> {
    conn.query_row(
        "SELECT mode, identity FROM vault_lock_file_modes WHERE path = ?1",
        params![path],
        |row| {
            Ok(FileMode {
                mode: row.get(0)?,
                identity: row.get(1)?,
            })
        },
    )
    .optional()
    .map_err(failed)
}

/// Records `mode` and `identity` for the file at `path`, replacing any record.
pub fn record_file_mode(
    conn: &Connection,
    path: &str,
    mode: u32,
    identity: Option<&str>,
) -> Result<(), StorageError> {
    conn.execute(
        "INSERT INTO vault_lock_file_modes (path, mode, identity) VALUES (?1, ?2, ?3)
         ON CONFLICT (path) DO UPDATE SET mode = excluded.mode, identity = excluded.identity",
        params![path, mode, identity],
    )
    .map(drop)
    .map_err(failed)
}

/// Drops the record of the file at `path`: no lock covers it any more.
pub fn forget_file_mode(conn: &Connection, path: &str) -> Result<(), StorageError> {
    conn.execute(
        "DELETE FROM vault_lock_file_modes WHERE path = ?1",
        params![path],
    )
    .map(drop)
    .map_err(failed)
}

/// Every recorded file, by vault-relative path.
pub fn file_modes(conn: &Connection) -> Result<Vec<(String, FileMode)>, StorageError> {
    let mut statement = conn
        .prepare_cached("SELECT path, mode, identity FROM vault_lock_file_modes ORDER BY path")
        .map_err(failed)?;
    statement
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                FileMode {
                    mode: row.get(1)?,
                    identity: row.get(2)?,
                },
            ))
        })
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)
}

fn locked_folders(conn: &Connection) -> Result<Vec<String>, StorageError> {
    Ok(locked_targets(conn, TargetKind::Folder)?
        .iter()
        .map(|target| normalize_folder_path(target))
        .collect())
}

/// The targets of `kind`'s live locked rows, oldest first.
fn locked_targets(conn: &Connection, kind: TargetKind) -> Result<Vec<String>, StorageError> {
    let mut statement = conn
        .prepare_cached(
            "SELECT target FROM vault_locks
             WHERE target_kind = ?1 AND locked = 1 AND deleted_at IS NULL
             ORDER BY rowid",
        )
        .map_err(failed)?;
    statement
        .query_map(params![kind.as_str()], |row| row.get(0))
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)
}

fn is_under(path: &str, folder: &str) -> bool {
    folder.is_empty()
        || path == folder
        || path
            .strip_prefix(folder)
            .is_some_and(|rest| rest.starts_with('/'))
}

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}
