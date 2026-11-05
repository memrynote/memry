//! The property values of a note's or a journal day's file that reach its record: an edit made
//! outside the app, measured against what the record last took from the file (desktop, #3530
//! 13k-4c). The vault tier asks here once the file's text reached the document, for bytes the
//! app did not write, and for a file it names; nothing here reads a file.
//!
//! The values the record last took from the file are the item's **baseline**, kept on this
//! device only, in `meta` (`note.file_properties:<id>`, a JSON object of the values as the
//! record stores them; an older build ignores the key, so no migration). It is written by each
//! take, and moved by each app edit's mirror ([`super::mirror_file`]) by the keys the edit set
//! and dropped. A frontmatter that does not parse never reaches here, so a half-typed value
//! leaves the baseline as it was. It holds no file hash: a body the write-back writes into the
//! file changes its hash and none of its values, and the values alone decide what an edit
//! changed.
//!
//! An item with no baseline (one found or made by an older build) falls back to the index's
//! reading of the replaced file, when the caller has one. With neither, the record takes only
//! the keys it lacks ([`super::fill_file`]): a key it holds may be a pulled value the file does
//! not hold yet, which the server's record wins. A found file, which no baseline knows, takes
//! its properties that way.

use rusqlite::{Connection, OptionalExtension as _, params};
use serde_json::{Map, Value};

use crate::api::errors::StorageError;

use super::{edit_file, failed, fill_file, mirrored};

/// The `meta` key prefix of an item's baseline.
const BASELINE: &str = "note.file_properties:";

/// Takes the file's property values `after` into the record `id`; `indexed` is the index's
/// reading of the file the edit replaced, when it read that file. `Ok(false)` when no live note
/// or day has that id.
pub fn taken(
    conn: &Connection,
    id: &str,
    indexed: Option<Map<String, Value>>,
    after: Map<String, Value>,
    device_id: &str,
    now_ms: i64,
) -> Result<bool, StorageError> {
    let tx = conn.unchecked_transaction().map_err(failed)?;
    let found = take_in(&tx, id, indexed, after, device_id, now_ms)?;
    tx.commit().map_err(failed)?;
    Ok(found)
}

/// [`taken`] of each found file `(id, after)`, in one transaction: the open walk names many
/// new files together.
pub fn taken_all(
    conn: &Connection,
    files: Vec<(String, Map<String, Value>)>,
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    let tx = conn.unchecked_transaction().map_err(failed)?;
    for (id, after) in files {
        take_in(&tx, &id, None, after, device_id, now_ms)?;
    }
    tx.commit().map_err(failed)
}

fn take_in(
    tx: &Connection,
    id: &str,
    indexed: Option<Map<String, Value>>,
    after: Map<String, Value>,
    device_id: &str,
    now_ms: i64,
) -> Result<bool, StorageError> {
    let found = match baseline(tx, id)?.or(indexed) {
        Some(before) => {
            let (changed, removed) = delta(&before, &after);
            edit_file(tx, id, device_id, now_ms, |next| {
                mirrored(next, changed, &removed);
            })?
        }
        None => fill_file(tx, id, after.clone(), device_id, now_ms)?,
    };
    if found {
        record(tx, id, &after)?;
    }
    Ok(found)
}

/// An app edit set `changed` and dropped `removed` in the item's file: its baseline, when it has
/// one, moves with them.
pub(super) fn moved(
    conn: &Connection,
    id: &str,
    changed: &Map<String, Value>,
    removed: &[String],
) -> Result<(), StorageError> {
    let Some(mut values) = baseline(conn, id)? else {
        return Ok(());
    };
    mirrored(&mut values, changed.clone(), removed);
    record(conn, id, &values)
}

/// The keys `after` set (new, or with another value) and the keys it dropped, from `before`.
fn delta(
    before: &Map<String, Value>,
    after: &Map<String, Value>,
) -> (Map<String, Value>, Vec<String>) {
    let changed = after
        .iter()
        .filter(|(name, value)| before.get(*name) != Some(value))
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect();
    let removed = before
        .keys()
        .filter(|name| !after.contains_key(*name))
        .cloned()
        .collect();
    (changed, removed)
}

fn baseline(conn: &Connection, id: &str) -> Result<Option<Map<String, Value>>, StorageError> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM meta WHERE key = ?1",
            params![format!("{BASELINE}{id}")],
            |row| row.get(0),
        )
        .optional()
        .map_err(failed)?;
    // A value that does not read is no baseline: the fallback, or a fill, is taken instead.
    Ok(raw.and_then(|raw| serde_json::from_str(&raw).ok()))
}

fn record(conn: &Connection, id: &str, values: &Map<String, Value>) -> Result<(), StorageError> {
    let value = serde_json::to_string(values).map_err(|error| StorageError::Failed {
        what: format!("a file's property values will not serialise: {error}"),
    })?;
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![format!("{BASELINE}{id}"), value],
    )
    .map_err(failed)?;
    Ok(())
}
