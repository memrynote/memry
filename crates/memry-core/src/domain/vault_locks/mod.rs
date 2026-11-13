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
//! Each lock is a `vault_lock` sync record (Step 16, #3533): the record in
//! `sync_items` is the owner and `vault_locks` its projection
//! ([`crate::storage::repositories::projectors::vault_locks`]). [`set`] writes
//! the record and its outbox row in one transaction, and [`merge`] applies a
//! peer's. Locks a build between Step 14e and Step 16 wrote have a row and no
//! record; [`seed_unsynced`] gives each one its record before a sync pass.
//!
//! Beside them, the device-local rows the desktop lock guard keeps, never synced:
//! each locked markdown note's [`Baseline`] and each locked file's [`FileMode`]
//! (`vault_lock_baselines`, `vault_lock_file_modes`, Electron's `store.ts`).

pub mod merge;

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

use crate::api::errors::StorageError;
use crate::domain::notes::journal_day::body_owner;
use crate::domain::notes::{iso, next_clock, object, require_payload};
use crate::domain::recreate::write_over_tombstone;
use crate::storage::repositories::schema::Object;
use crate::storage::repositories::{Change, sync_items};
use crate::sync::outbox;

/// The sync type of a lock record.
pub const ITEM_TYPE: &str = "vault_lock";

/// The kinds this build knows (`VAULT_LOCK_TARGET_KINDS`,
/// `packages/contracts/src/vault-locks-api.ts`).
pub fn is_known_kind(kind: &str) -> bool {
    matches!(kind, "note" | "folder")
}

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
/// Unlocking keeps the record with `locked: false`. A note must be a live note
/// or journal day, and a folder path must not be empty; whether the folder
/// exists on disk is the shell's to check.
///
/// A change writes the record under `device_id`'s next clock tick and queues it
/// in the same transaction. [`SetOutcome::Unchanged`] writes and queues nothing
/// (Electron's `writeLockRow` queues an update even then). A lock over a
/// tombstone, which a peer's delete leaves, ticks past every delete clock this
/// device knows for the id, or the server refuses it.
pub fn set(
    conn: &Connection,
    kind: TargetKind,
    target: &str,
    locked: bool,
    device_id: &str,
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
    let outcome = match live {
        Some(current) if current == locked => return Ok(SetOutcome::Unchanged),
        None if !locked => return Ok(SetOutcome::Unchanged),
        Some(_) => SetOutcome::Updated,
        None => SetOutcome::Created,
    };
    outbox::commit(
        conn,
        &outbox::Change::upsert(ITEM_TYPE, &id),
        now_ms,
        |tx| {
            let record = sync_items::load(tx, ITEM_TYPE, &id)?;
            if record.is_some_and(|row| row.deleted_at.is_none()) {
                let stored = require_payload(tx, ITEM_TYPE, &id)?;
                let changes = [
                    ("locked", Change::set(locked)),
                    ("updatedAt", Change::set(iso(now_ms)?)),
                    (
                        "clock",
                        Change::Set(next_clock(stored.object(), device_id)?),
                    ),
                ];
                sync_items::apply_local_edit_in(tx, ITEM_TYPE, &id, &changes, now_ms)?;
                return Ok(());
            }
            // No live record: a new lock, a lock over a peer's delete, or a
            // row with no record (written before Step 16, or copied in), which
            // keeps its `createdAt`. A row's clock is the lineage the new one
            // ticks from, so a lock the server already holds is not replayed.
            let (row_created, row_clock) = row_lineage(tx, &id)?.unzip();
            let created_at = match outcome {
                SetOutcome::Updated => row_created.unwrap_or(now_ms),
                _ => now_ms,
            };
            let mut payload = lock_payload(kind.as_str(), &target, locked, created_at, now_ms)?;
            if let Some(clock) = row_clock.flatten() {
                payload.insert("clock".to_owned(), clock);
            }
            write_over_tombstone(tx, ITEM_TYPE, &id, payload, device_id, now_ms).map(drop)
        },
    )?;
    Ok(outcome)
}

/// Gives every lock row written before Step 16 its `vault_lock` record and
/// queues it (Electron's `seedUnclocked`): a row with no clock, not deleted,
/// and with no record. Idempotent, so a sync pass runs it every time. Returns
/// how many it queued.
pub fn seed_unsynced(
    conn: &Connection,
    device_id: &str,
    now_ms: i64,
) -> Result<usize, StorageError> {
    type Unsynced = (String, String, String, bool, i64, i64);
    let rows: Vec<Unsynced> = {
        let mut statement = conn
            .prepare(
                "SELECT id, target_kind, target, locked, created_at, updated_at FROM vault_locks v
                 WHERE clock IS NULL AND deleted_at IS NULL AND NOT EXISTS (
                   SELECT 1 FROM sync_items s WHERE s.item_type = ?1 AND s.item_id = v.id)
                 ORDER BY rowid",
            )
            .map_err(failed)?;
        statement
            .query_map(params![ITEM_TYPE], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            })
            .map_err(failed)?
            .collect::<Result<_, _>>()
            .map_err(failed)?
    };
    if rows.is_empty() {
        return Ok(0);
    }
    let tx = conn.unchecked_transaction().map_err(failed)?;
    for (id, kind, target, locked, created_at, updated_at) in &rows {
        let payload = lock_payload(kind, target, *locked, *created_at, *updated_at)?;
        write_over_tombstone(&tx, ITEM_TYPE, id, payload, device_id, now_ms)?;
        outbox::enqueue(&tx, &outbox::Change::upsert(ITEM_TYPE, id), now_ms)?;
    }
    tx.commit().map_err(failed)?;
    Ok(rows.len())
}

/// Electron's push shape (`VaultLockHandler.buildPushPayload`), keys in its
/// order. `clock` is a placeholder [`write_over_tombstone`] fills in.
fn lock_payload(
    kind: &str,
    target: &str,
    locked: bool,
    created_at: i64,
    updated_at: i64,
) -> Result<Object, StorageError> {
    Ok(object(json!({
        "targetKind": kind,
        "target": target,
        "locked": locked,
        "clock": Value::Null,
        "createdAt": iso(created_at)?,
        "updatedAt": iso(updated_at)?,
    })))
}

/// A lock row's `created_at`, and its `clock` when it has one. A stored clock
/// that is not a JSON object is an error: dropping it would tick the new
/// record from nothing, and the server refuses a lock it already holds.
fn row_lineage(conn: &Connection, id: &str) -> Result<Option<(i64, Option<Value>)>, StorageError> {
    let row: Option<(i64, Option<String>)> = conn
        .query_row(
            "SELECT created_at, clock FROM vault_locks WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(failed)?;
    let Some((created_at, clock)) = row else {
        return Ok(None);
    };
    let clock = match clock {
        None => None,
        Some(text) => match serde_json::from_str::<Value>(&text) {
            Ok(clock) if clock.is_object() => Some(clock),
            _ => {
                return Err(StorageError::Failed {
                    what: format!("vault lock {id}: the stored clock is not a vector clock"),
                });
            }
        },
    };
    Ok(Some((created_at, clock)))
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

#[cfg(test)]
mod tests;
