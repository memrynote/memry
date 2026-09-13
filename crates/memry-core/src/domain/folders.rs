//! Folders: create, rename, move, delete (T126, FR-051, chapter 13 §13.7.10,
//! data-model §A.4).
//!
//! **A folder id is its path** (§13.6, §A.4). Everything awkward in this file
//! follows from that one fact:
//!
//! - a rename or a move **changes the id**, so it is a create at the new key
//!   and a tombstone at the old one, not an update in place;
//! - every descendant `folder_config` id carries the same prefix, so it moves
//!   with its ancestor, and so does every `note.folderPath` inside the subtree;
//! - all of it is **one transaction**. A tree half-moved is a tree no peer can
//!   interpret, and the outbox rows that publish the halves are written in the
//!   same transaction as the halves themselves (FR-030, §A.2).
//!
//! A `folder_config` record is *configuration for* a folder, not the folder
//! itself: its modelled fields are `icon`, `clock`, `createdAt` and
//! `modifiedAt` (§13.7.10). A folder that holds notes exists on desktop
//! whether or not a `folder_config` row describes it, so [`relocate`] moves
//! the notes of a subtree that has no `folder_config` row at all, and
//! [`delete`] refuses a subtree that still holds notes.
//!
//! **Recorded gap, not a guess:** no chapter states what a folder rename does
//! to descendant ids or to `note.folderPath`, and none states whether a folder
//! delete cascades. FR-051 requires the resulting hierarchy to match desktop
//! for the same operations, and a path-keyed id leaves the prefix rewrite as
//! the only self-consistent reading — a rename that did not rewrite would
//! leave the notes behind and fork the folder in two. The cascade is the
//! opposite case: deleting notes is not recoverable, so this module refuses
//! rather than invents one.

use rusqlite::Connection;

use crate::api::errors::StorageError;
use crate::storage::repositories::{Change, sync_items};
use crate::sync::outbox::{self, Durable};

use super::notes::{self, failed, insert_local, iso, next_clock, object, stamp, tombstone_local};
use serde_json::json;

/// The `(type, _)` half of every key this module writes.
pub const ITEM_TYPE: &str = "folder_config";

/// What a rename or a move actually touched.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Relocation {
    pub from: String,
    pub to: String,
    /// `(old path, new path)` for every `folder_config` row that moved,
    /// including the folder named in the request when it has one.
    pub folders: Vec<(String, String)>,
    /// The ids of the notes whose `folderPath` was rewritten.
    pub notes: Vec<String>,
}

/// What a delete tombstoned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Removal {
    pub folders: Vec<String>,
}

/// Creates a `folder_config` at `path`.
///
/// `icon` is written as an explicit `null` when absent, because §13.7.10 makes
/// the key nullable rather than optional: it is always present, and its value
/// may be `null`.
pub fn create(
    conn: &Connection,
    path: &str,
    icon: Option<&str>,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<String>, StorageError> {
    let path = valid_path(path)?.to_owned();
    outbox::commit(
        conn,
        &outbox::Change::upsert(ITEM_TYPE, &path),
        now_ms,
        |tx| {
            let at = iso(now_ms)?;
            let payload = object(json!({
                "icon": icon,
                "clock": next_clock(&Default::default(), device_id)?,
                "createdAt": at,
                "modifiedAt": at,
            }));
            insert_local(tx, ITEM_TYPE, &path, payload, now_ms)
        },
    )
}

/// Renames a folder in place, keeping its parent.
pub fn rename(
    conn: &Connection,
    path: &str,
    new_name: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Relocation, StorageError> {
    let path = valid_path(path)?;
    let name = valid_name(new_name)?;
    let target = match parent_of(path) {
        Some(parent) => format!("{parent}/{name}"),
        None => name.to_owned(),
    };
    relocate(conn, path, &target, device_id, now_ms)
}

/// Moves a folder under `new_parent`, or to the vault root with `None`.
pub fn move_to(
    conn: &Connection,
    path: &str,
    new_parent: Option<&str>,
    device_id: &str,
    now_ms: i64,
) -> Result<Relocation, StorageError> {
    let path = valid_path(path)?;
    let name = name_of(path);
    let target = match new_parent {
        Some(parent) => format!("{}/{name}", valid_path(parent)?),
        None => name.to_owned(),
    };
    relocate(conn, path, &target, device_id, now_ms)
}

/// Tombstones a folder and every `folder_config` under it.
///
/// **Refuses a subtree that still holds a live note.** No chapter defines a
/// cascading folder delete, and a note tombstone travels to every device in
/// the vault; refusing costs a step in the caller's UI, guessing costs a
/// user's notes.
pub fn delete(
    conn: &Connection,
    path: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Removal, StorageError> {
    let path = valid_path(path)?;
    let tx = conn.unchecked_transaction().map_err(failed)?;

    let held = notes_within(&tx, path)?;
    if !held.is_empty() {
        return Err(StorageError::Failed {
            what: format!(
                "folder `{path}` still holds {} note(s); move or delete them first",
                held.len()
            ),
        });
    }
    let folders = folders_within(&tx, path)?;
    if folders.is_empty() {
        return Err(StorageError::Failed {
            what: format!("no folder `{path}` to delete"),
        });
    }
    for folder in &folders {
        tombstone_local(&tx, ITEM_TYPE, folder, device_id, now_ms)?;
        outbox::enqueue(&tx, &outbox::Change::delete(ITEM_TYPE, folder), now_ms)?;
    }
    tx.commit().map_err(failed)?;
    Ok(Removal { folders })
}

/// The prefix rewrite both [`rename`] and [`move_to`] are.
fn relocate(
    conn: &Connection,
    from: &str,
    to: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Relocation, StorageError> {
    let to = valid_path(to)?;
    if from == to {
        return Err(StorageError::Failed {
            what: format!("folder `{from}` is already there"),
        });
    }
    if within(to, from) {
        return Err(StorageError::Failed {
            what: format!("folder `{from}` cannot be moved inside itself"),
        });
    }

    let tx = conn.unchecked_transaction().map_err(failed)?;
    if !folders_within(&tx, to)?.is_empty() || !notes_within(&tx, to)?.is_empty() {
        return Err(StorageError::Failed {
            what: format!("`{to}` is already in use"),
        });
    }

    let mut folders = Vec::new();
    for folder in folders_within(&tx, from)? {
        let target = rewritten(&folder, from, to);
        move_config(&tx, &folder, &target, device_id, now_ms)?;
        folders.push((folder, target));
    }

    let mut moved = Vec::new();
    for (note_id, folder_path) in notes_within(&tx, from)? {
        let target = rewritten(&folder_path, from, to);
        let mut changes = stamp(&tx, notes::ITEM_TYPE, &note_id, device_id, now_ms)?;
        changes.push(("folderPath", Change::set(target)));
        sync_items::apply_local_edit_in(&tx, notes::ITEM_TYPE, &note_id, &changes, now_ms)?;
        outbox::enqueue(
            &tx,
            &outbox::Change::upsert(notes::ITEM_TYPE, &note_id),
            now_ms,
        )?;
        moved.push(note_id);
    }

    tx.commit().map_err(failed)?;
    Ok(Relocation {
        from: from.to_owned(),
        to: to.to_owned(),
        folders,
        notes: moved,
    })
}

/// Re-keys one `folder_config`: the same payload under the new id, and a
/// tombstone under the old one.
///
/// The new row is built from the **stored bytes** of the old one, so a key
/// this build does not model moves with the folder instead of being dropped by
/// the re-key (§13.2, FR-033).
fn move_config(
    tx: &Connection,
    from: &str,
    to: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    let parsed = notes::require_payload(tx, ITEM_TYPE, from)?;
    let mut payload = parsed.object().clone();
    payload.insert("clock".to_owned(), next_clock(parsed.object(), device_id)?);
    payload.insert("modifiedAt".to_owned(), json!(iso(now_ms)?));

    insert_local(tx, ITEM_TYPE, to, payload, now_ms)?;
    outbox::enqueue(tx, &outbox::Change::upsert(ITEM_TYPE, to), now_ms)?;
    tombstone_local(tx, ITEM_TYPE, from, device_id, now_ms)?;
    outbox::enqueue(tx, &outbox::Change::delete(ITEM_TYPE, from), now_ms)?;
    Ok(())
}

/// Every live `folder_config` path at or under `root`.
///
/// Filtered in Rust rather than with `LIKE`, because a folder name may contain
/// `%` or `_` and a pattern would then match the wrong subtree. A row that
/// will not read is an error, never a skipped row (FR-032's rule generalised:
/// a reader never reports "none" for "could not tell").
fn folders_within(tx: &Connection, root: &str) -> Result<Vec<String>, StorageError> {
    let mut statement = tx
        .prepare("SELECT path FROM folders WHERE deleted_at IS NULL ORDER BY path")
        .map_err(failed)?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(failed)?;
    let mut found = Vec::new();
    for row in rows {
        let path = row.map_err(failed)?;
        if within(&path, root) {
            found.push(path);
        }
    }
    Ok(found)
}

/// Every live note at or under `root`, as `(id, folder_path)`.
fn notes_within(tx: &Connection, root: &str) -> Result<Vec<(String, String)>, StorageError> {
    let mut statement = tx
        .prepare(
            "SELECT id, folder_path FROM notes
              WHERE deleted_at IS NULL AND folder_path IS NOT NULL ORDER BY id",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(failed)?;
    let mut found = Vec::new();
    for row in rows {
        let (id, folder_path) = row.map_err(failed)?;
        if within(&folder_path, root) {
            found.push((id, folder_path));
        }
    }
    Ok(found)
}

/// Whether `path` is `root` or sits under it. A prefix test alone would make
/// `Notes2` a child of `Notes`.
pub(crate) fn within(path: &str, root: &str) -> bool {
    path == root
        || path
            .strip_prefix(root)
            .is_some_and(|rest| rest.starts_with('/'))
}

/// `path` with the `from` prefix replaced by `to`.
fn rewritten(path: &str, from: &str, to: &str) -> String {
    match path.strip_prefix(from) {
        Some(rest) => format!("{to}{rest}"),
        None => path.to_owned(),
    }
}

/// The parent of a folder path, or `None` at the vault root.
pub(crate) fn parent_of(path: &str) -> Option<&str> {
    path.rsplit_once('/').map(|(parent, _)| parent)
}

/// The last segment of a folder path.
pub(crate) fn name_of(path: &str) -> &str {
    path.rsplit_once('/').map_or(path, |(_, name)| name)
}

/// A folder path: at least one segment, no empty segment, no traversal.
///
/// The path is an item id on the wire and a prefix every descendant carries,
/// so a malformed one is refused at the door rather than stored and puzzled
/// over on another device.
pub fn valid_path(path: &str) -> Result<&str, StorageError> {
    let ok = !path.is_empty()
        && !path.starts_with('/')
        && !path.ends_with('/')
        && path.split('/').all(segment_ok);
    if ok {
        Ok(path)
    } else {
        Err(StorageError::Failed {
            what: format!("`{path}` is not a folder path"),
        })
    }
}

/// One segment of a folder path.
pub fn valid_name(name: &str) -> Result<&str, StorageError> {
    if segment_ok(name) && !name.contains('/') {
        Ok(name)
    } else {
        Err(StorageError::Failed {
            what: format!("`{name}` is not a folder name"),
        })
    }
}

fn segment_ok(segment: &str) -> bool {
    !segment.is_empty()
        && segment != "."
        && segment != ".."
        && !segment.contains('\0')
        && segment.trim() == segment
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_sibling_sharing_a_prefix_is_not_a_child() {
        assert!(within("Notes", "Notes"));
        assert!(within("Notes/Protocol", "Notes"));
        assert!(!within("Notes2", "Notes"));
        assert!(!within("Note", "Notes"));
    }

    #[test]
    fn the_prefix_rewrite_keeps_the_tail() {
        assert_eq!(rewritten("Notes/A/B", "Notes", "Archive"), "Archive/A/B");
        assert_eq!(rewritten("Notes", "Notes", "Archive/2026"), "Archive/2026");
        assert_eq!(rewritten("Other", "Notes", "Archive"), "Other");
    }

    #[test]
    fn a_path_is_refused_before_it_can_become_an_item_id() {
        assert!(valid_path("Notes/Protocol").is_ok());
        assert!(valid_path("").is_err());
        assert!(valid_path("/Notes").is_err());
        assert!(valid_path("Notes/").is_err());
        assert!(valid_path("Notes//Protocol").is_err());
        assert!(valid_path("Notes/../etc").is_err());
        assert!(valid_path("Notes/ Protocol").is_err());
        assert!(valid_name("Protocol").is_ok());
        assert!(valid_name("a/b").is_err());
    }

    #[test]
    fn a_parent_and_a_name_come_out_of_the_path() {
        assert_eq!(parent_of("Notes/Protocol"), Some("Notes"));
        assert_eq!(parent_of("Notes"), None);
        assert_eq!(name_of("Notes/Protocol"), "Protocol");
        assert_eq!(name_of("Notes"), "Notes");
    }
}
