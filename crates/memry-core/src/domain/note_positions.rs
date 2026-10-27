//! Manual order of notes and folders in the sidebar (desktop Step 13), after
//! `database/queries/note-positions.ts`.
//!
//! One `note_positions` row per vault-relative path (migration 16). A note's
//! path and a folder's path share one namespace per parent folder, and the
//! vault root is the empty `folder_path`. The tree reads a missing row as
//! "last", so a row exists only for an item somebody ordered by hand; every
//! function here keeps that rule instead of writing a row for everything.
//!
//! Every function runs on the caller's connection, in or out of a transaction:
//! one that needs several statements to be all or nothing wraps them in a
//! savepoint, which nests, so a folder rename in [`super::folders`] carries its
//! order rows inside its own transaction.
//!
//! The table is device-local and never synced, so there is no outbox row and
//! no clock. It is keyed by path, which is why a rename or a move has to carry
//! the row ([`carry`], [`carry_folder`]) and a delete has to drop it
//! ([`remove`], [`drop_folder`]): left behind, a row is inherited by whatever
//! is later created at the same path.
//!
//! A subtree is matched with a byte range over the path (`folder/` up to
//! `folder0`, the next byte after `/`), never with `LIKE`: a folder name may
//! contain `%` or `_`.

use rusqlite::{Connection, params};

use crate::api::errors::StorageError;

use super::notes::failed;

/// One `note_positions` row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotePosition {
    pub path: String,
    pub folder_path: String,
    pub position: i64,
}

fn read(row: &rusqlite::Row<'_>) -> rusqlite::Result<NotePosition> {
    Ok(NotePosition {
        path: row.get(0)?,
        folder_path: row.get(1)?,
        position: row.get(2)?,
    })
}

/// The first and the one-past-last path a `folder` subtree can hold.
fn subtree(folder: &str) -> (String, String) {
    (format!("{folder}/"), format!("{folder}0"))
}

/// The parent folder of a vault-relative path; the root is `""`.
fn parent_of(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(parent, _)| parent)
}

/// Runs `work` as one unit on `conn`, whether or not a transaction is open.
fn atomically<T>(
    conn: &Connection,
    work: impl FnOnce() -> Result<T, StorageError>,
) -> Result<T, StorageError> {
    conn.execute_batch("SAVEPOINT note_positions")
        .map_err(failed)?;
    match work() {
        Ok(value) => {
            conn.execute_batch("RELEASE note_positions")
                .map_err(failed)?;
            Ok(value)
        }
        Err(error) => {
            // The unit failed; undo it and leave the caller's transaction as
            // it was. A rollback that itself fails is not worth masking the
            // first error for.
            let _ = conn.execute_batch("ROLLBACK TO note_positions; RELEASE note_positions");
            Err(error)
        }
    }
}

fn upsert(
    conn: &Connection,
    path: &str,
    folder_path: &str,
    position: i64,
) -> Result<(), StorageError> {
    conn.execute(
        "INSERT INTO note_positions (path, folder_path, position) VALUES (?1, ?2, ?3)
         ON CONFLICT(path) DO UPDATE SET folder_path = excluded.folder_path,
                                         position = excluded.position",
        params![path, folder_path, position],
    )
    .map_err(failed)?;
    Ok(())
}

fn row_at(conn: &Connection, path: &str) -> Result<Option<NotePosition>, StorageError> {
    let mut statement = conn
        .prepare("SELECT path, folder_path, position FROM note_positions WHERE path = ?1")
        .map_err(failed)?;
    let mut rows = statement.query_map([path], read).map_err(failed)?;
    rows.next().transpose().map_err(failed)
}

/// Every ordered item directly in `folder`, in order (`""` is the root).
pub fn for_folder(conn: &Connection, folder: &str) -> Result<Vec<NotePosition>, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT path, folder_path, position FROM note_positions
              WHERE folder_path = ?1 ORDER BY position, path",
        )
        .map_err(failed)?;
    statement
        .query_map([folder], read)
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)
}

/// Every row, for the tree's first paint.
pub fn all(conn: &Connection) -> Result<Vec<NotePosition>, StorageError> {
    let mut statement = conn
        .prepare("SELECT path, folder_path, position FROM note_positions ORDER BY path")
        .map_err(failed)?;
    statement
        .query_map([], read)
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)
}

/// Makes `paths` the order of `folder`: slot `i` for the item at index `i`.
/// All or nothing.
pub fn reorder(conn: &Connection, folder: &str, paths: &[String]) -> Result<(), StorageError> {
    atomically(conn, || {
        for (index, path) in paths.iter().enumerate() {
            upsert(conn, path, folder, index as i64)?;
        }
        Ok(())
    })
}

/// Gives a new item the slot above every ordered sibling, so a new note opens
/// at the top of a folder the user arranged by hand instead of at the bottom
/// (#1646).
///
/// A folder nobody ordered keeps its implicit order (notes newest first,
/// folders A to Z), and this writes nothing there: a row would freeze that
/// order for good. A row an earlier item left at this exact path is cleared
/// either way, so the new item cannot inherit a dead slot.
pub fn place_at_top(conn: &Connection, item_path: &str, folder: &str) -> Result<(), StorageError> {
    let lowest: Option<i64> = conn
        .query_row(
            "SELECT MIN(position) FROM note_positions WHERE folder_path = ?1 AND path <> ?2",
            params![folder, item_path],
            |row| row.get(0),
        )
        .map_err(failed)?;
    match lowest {
        Some(lowest) => upsert(conn, item_path, folder, lowest - 1),
        None => remove(conn, item_path).map(drop),
    }
}

/// Carries a position across a rename: the same slot, the same parent.
/// Nothing happens for an item that never had one.
pub fn carry(conn: &Connection, old_path: &str, new_path: &str) -> Result<(), StorageError> {
    if old_path == new_path {
        return Ok(());
    }
    let Some(existing) = row_at(conn, old_path)? else {
        return Ok(());
    };
    atomically(conn, || {
        remove(conn, old_path)?;
        upsert(conn, new_path, &existing.folder_path, existing.position)
    })
}

/// Re-keys a renamed or moved folder: its own row and every row beneath it.
/// The folder's own parent is re-derived from the new path, because a folder
/// rename also serves a drag to another parent.
pub fn carry_folder(conn: &Connection, old_path: &str, new_path: &str) -> Result<(), StorageError> {
    if old_path == new_path {
        return Ok(());
    }
    let own = row_at(conn, old_path)?;
    let (from, to) = subtree(old_path);
    let mut statement = conn
        .prepare(
            "SELECT path, folder_path, position FROM note_positions
              WHERE path >= ?1 AND path < ?2",
        )
        .map_err(failed)?;
    let beneath: Vec<NotePosition> = statement
        .query_map([&from, &to], read)
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)?;
    if own.is_none() && beneath.is_empty() {
        return Ok(());
    }

    atomically(conn, || {
        if let Some(own) = own {
            remove(conn, old_path)?;
            upsert(conn, new_path, parent_of(new_path), own.position)?;
        }
        for row in beneath {
            let moved = format!("{new_path}/{}", &row.path[from.len()..]);
            let folder = if row.folder_path == old_path {
                new_path.to_owned()
            } else {
                match row.folder_path.strip_prefix(&from) {
                    Some(rest) => format!("{new_path}/{rest}"),
                    None => row.folder_path.clone(),
                }
            };
            remove(conn, &row.path)?;
            upsert(conn, &moved, &folder, row.position)?;
        }
        Ok(())
    })
}

/// Drops one item's row. `true` when there was one.
pub fn remove(conn: &Connection, path: &str) -> Result<bool, StorageError> {
    let changed = conn
        .execute("DELETE FROM note_positions WHERE path = ?1", [path])
        .map_err(failed)?;
    Ok(changed > 0)
}

/// Drops a deleted folder's row and every row beneath it. One statement, so it
/// also runs inside the caller's transaction.
pub fn drop_folder(conn: &Connection, folder: &str) -> Result<usize, StorageError> {
    let (from, to) = subtree(folder);
    conn.execute(
        "DELETE FROM note_positions WHERE path = ?1 OR (path >= ?2 AND path < ?3)",
        params![folder, from, to],
    )
    .map_err(failed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_subtree_range_excludes_a_sibling_that_shares_the_prefix() {
        let (from, to) = subtree("a");
        assert_eq!((from.as_str(), to.as_str()), ("a/", "a0"));
        // `ab` sorts after `a0`, `a/x` between the two.
        assert!("a/x" >= from.as_str() && "a/x" < to.as_str());
        assert!(!("ab" >= from.as_str() && "ab" < to.as_str()));
    }

    #[test]
    fn a_parent_comes_out_of_a_path() {
        assert_eq!(parent_of("a/b/c.md"), "a/b");
        assert_eq!(parent_of("c.md"), "");
    }
}
