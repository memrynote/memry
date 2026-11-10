//! A journal day held, never crossed (desktop Step 13m-7b-2b stage c, #3530). The day's file
//! moved with the whole journal folder outside the app, so the move its record is owed
//! (`note_place_owed`) waits for the journal setting to follow the folder. Crossed into a note,
//! the day would be deleted and the delete synced. The desktop tier decides the hold once, from
//! the disk when the day moved, and keeps it here ([`hold`]): nothing that happens on disk
//! afterwards, such as the old folder made again, turns a held day into a crossing.
//!
//! The format crosses builds: one `meta` row per held day, key [`PREFIX`] and the note id, value
//! the owed `from_path` the hold was made for. The hold lasts as long as the day's owed move
//! from that path: settling or dropping the move forgets it ([`forget`]), and a hold whose owed
//! move is gone, or now owes another path, is dropped when read ([`held`]), which covers an
//! older build that settled the move without knowing the key. A build before this one never
//! reads the key and decides the hold from the disk each time, as before.

#[cfg(feature = "markdown")]
use std::collections::BTreeSet;

use rusqlite::{Connection, params};

use super::failed;
use crate::api::errors::StorageError;

/// The `meta` key of a held day, before its note id.
const PREFIX: &str = "notes.place_held.v1:";
/// The first key after every key with [`PREFIX`] (`:` is followed by `;`).
#[cfg(feature = "markdown")]
const PREFIX_END: &str = "notes.place_held.v1;";

/// Holds the owed move of `note_id`, in the caller's transaction. Does nothing when the note
/// owes no move.
#[cfg(feature = "markdown")]
pub(super) fn hold(conn: &Connection, note_id: &str) -> Result<(), StorageError> {
    conn.execute(
        "INSERT INTO meta (key, value)
         SELECT ?1 || note_id, from_path FROM note_place_owed WHERE note_id = ?2
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![PREFIX, note_id],
    )
    .map(drop)
    .map_err(failed)
}

/// The notes whose owed move is held. A hold whose owed move is gone or names another path is
/// dropped first.
#[cfg(feature = "markdown")]
pub(super) fn held(conn: &Connection) -> Result<BTreeSet<String>, StorageError> {
    conn.execute(
        "DELETE FROM meta WHERE key >= ?1 AND key < ?2
           AND NOT EXISTS (SELECT 1 FROM note_place_owed o
                            WHERE o.note_id = substr(meta.key, ?3) AND o.from_path = meta.value)",
        params![PREFIX, PREFIX_END, PREFIX.len() as i64 + 1],
    )
    .map_err(failed)?;
    let mut statement = conn
        .prepare_cached("SELECT substr(key, ?3) FROM meta WHERE key >= ?1 AND key < ?2")
        .map_err(failed)?;
    let ids = statement
        .query_map(
            params![PREFIX, PREFIX_END, PREFIX.len() as i64 + 1],
            |row| row.get(0),
        )
        .map_err(failed)?;
    ids.collect::<Result<_, _>>().map_err(failed)
}

/// Whether the owed move of `note_id` is held: [`held`] for one note, read by its keys alone.
#[cfg(feature = "markdown")]
pub(super) fn is_held(conn: &Connection, note_id: &str) -> Result<bool, StorageError> {
    conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM meta WHERE key = ?1 || ?2
                          AND value = (SELECT from_path FROM note_place_owed WHERE note_id = ?2))",
        params![PREFIX, note_id],
        |row| row.get(0),
    )
    .map_err(failed)
}

/// Forgets the hold of `note_id`, whose owed move is settled or dropped.
pub(crate) fn forget(conn: &Connection, note_id: &str) -> Result<(), StorageError> {
    conn.execute(
        "DELETE FROM meta WHERE key = ?1 || ?2",
        params![PREFIX, note_id],
    )
    .map(drop)
    .map_err(failed)
}
