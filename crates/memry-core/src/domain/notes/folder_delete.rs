//! A folder the desktop app deletes (Step 13h, #3530), after `deleteFolderCommand`
//! (`apps/desktop/src/main/notes/domain.ts`): the folder leaves the disk, and every note in it,
//! the folder's `folder_config` records and its manual order go after it.
//!
//! The order is what makes a crash converge, as for a move ([`super::app_move`]). The vault tier
//! records the delete ([`begin`], one synced write), takes the folder off the disk, and then
//! calls [`deleted_by_app`]: one transaction tombstones every note, drops its `note_files` row,
//! tombstones the folder records, drops the subtree's order and forgets the record. A crash in
//! between leaves the record, and the next open, before its watcher starts, runs that
//! transaction for the notes still listed under the folder when the folder is gone, and forgets
//! the record when it is still there ([`pending`], [`abandon`]).
//!
//! The record's format crosses builds: `meta` key `notes.folder_delete.v1:<path>`, JSON
//! `{"version": 1}`. A build before this one does not know the key; a record of another version
//! or one that does not parse is left as it is, and holds back that folder's next delete only.

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use super::app_move::{BeginError, write_synced};
use super::{ITEM_TYPE, failed, tombstone_local};
use crate::api::errors::StorageError;
use crate::domain::{folders, note_files, note_positions};
use crate::sync::outbox;

const PREFIX: &str = "notes.folder_delete.v1:";
/// The first key after every key with [`PREFIX`].
const PREFIX_END: &str = "notes.folder_delete.v1;";
const RECORD_VERSION: u64 = 1;

#[derive(Serialize, Deserialize)]
struct Record {
    version: u64,
}

/// A folder's delete that [`begin`] recorded and that was not finished or forgotten.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FolderDeleteRecorded {
    /// A version 1 record of the delete of the folder at this path.
    Delete(String),
    /// A record this build cannot act on: the folder's path, and why.
    Unreadable(String, String),
}

fn key(path: &str) -> String {
    format!("{PREFIX}{path}")
}

/// Records the delete of the folder at `path` before it leaves the disk, on disk before it
/// returns. Refused while the folder has a record.
pub fn begin(conn: &Connection, path: &str) -> Result<(), BeginError> {
    if let Some(recorded) = recorded(conn, path)? {
        return Err(match recorded {
            FolderDeleteRecorded::Delete(_) => BeginError::Unsettled,
            FolderDeleteRecorded::Unreadable(_, why) => BeginError::Unreadable(why),
        });
    }
    let value = serde_json::to_string(&Record {
        version: RECORD_VERSION,
    })
    .map_err(|error| StorageError::Failed {
        what: error.to_string(),
    })?;
    Ok(write_synced(conn, &[(key(path), value)])?)
}

/// Every folder's record, by path.
pub fn pending(conn: &Connection) -> Result<Vec<FolderDeleteRecorded>, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT substr(key, ?1), value FROM meta WHERE key >= ?2 AND key < ?3 ORDER BY key",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map(
            params![PREFIX.len() as i64 + 1, PREFIX, PREFIX_END],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .map_err(failed)?;
    rows.map(|row| {
        let (path, value) = row.map_err(failed)?;
        Ok(parse(path, &value))
    })
    .collect()
}

fn recorded(conn: &Connection, path: &str) -> Result<Option<FolderDeleteRecorded>, StorageError> {
    let value: Option<String> = conn
        .query_row(
            "SELECT value FROM meta WHERE key = ?1",
            params![key(path)],
            |row| row.get(0),
        )
        .optional()
        .map_err(failed)?;
    Ok(value.map(|value| parse(path.to_owned(), &value)))
}

fn parse(path: String, value: &str) -> FolderDeleteRecorded {
    let version = serde_json::from_str::<serde_json::Value>(value)
        .ok()
        .and_then(|json| json.get("version").and_then(serde_json::Value::as_u64));
    match version {
        Some(RECORD_VERSION) => FolderDeleteRecorded::Delete(path),
        Some(version) => {
            FolderDeleteRecorded::Unreadable(path, format!("a version {version} record"))
        }
        None => FolderDeleteRecorded::Unreadable(path, "a record with no readable version".into()),
    }
}

/// Forgets the record of the folder's delete: the folder did not leave the disk. A record this
/// build cannot read stays. True when one was forgotten.
pub fn abandon(conn: &Connection, path: &str) -> Result<bool, StorageError> {
    if !matches!(recorded(conn, path)?, Some(FolderDeleteRecorded::Delete(_))) {
        return Ok(false);
    }
    conn.execute("DELETE FROM meta WHERE key = ?1", params![key(path)])
        .map_err(failed)?;
    Ok(true)
}

/// The folder at `path` left the disk with the notes `note_ids` in it: each note is tombstoned
/// (none is sent for a local-only one) and loses its `note_files` row, the folder's records are
/// tombstoned and the subtree's order dropped, and the folder's record of the delete is
/// forgotten, in one transaction. A folder no record can name ([`folders::valid_path`]) has no
/// records to tombstone. An `Err` leaves all of it as it was.
pub fn deleted_by_app(
    conn: &Connection,
    path: &str,
    note_ids: &[&str],
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    let tx = conn.unchecked_transaction().map_err(failed)?;
    for note_id in note_ids {
        // Before the row goes: the outbox reads off it whether the note is local-only.
        outbox::enqueue(&tx, &outbox::Change::delete(ITEM_TYPE, note_id), now_ms)?;
        tombstone_local(&tx, ITEM_TYPE, note_id, device_id, now_ms)?;
        note_files::remove_in(&tx, note_id)?;
    }
    if folders::valid_path(path).is_ok() {
        folders::delete_tree_in(&tx, path, device_id, now_ms)?;
    } else {
        note_positions::drop_folder(&tx, path)?;
    }
    abandon(&tx, path)?;
    tx.commit().map_err(failed)
}
