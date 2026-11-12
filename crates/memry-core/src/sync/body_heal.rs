//! The one-time body heal (#4315).
//!
//! Two older paths left a live note or journal with its record here and no
//! body state at all: no `crdt:<docId>` cursor, no row in either namespace of
//! the update log, and no debt. A first sync before #3264 never owed its
//! out-of-window documents, and a body pull that met an empty log settled the
//! debt without a cursor, so the feed dropped every later update. Such a
//! document stays empty to search and to backlinks until it is opened.
//!
//! The heal owes each of them a body pull once, under [`META_BODY_HEAL`]. The
//! pass's body step works the debts off within its budget, and a pull that
//! meets an empty log now leaves a cursor of `0`, so no document returns to
//! this state.

use rusqlite::Connection;

use crate::api::errors::StorageError;

use super::body_debt;
use super::first_sync_store::{read_meta, write_meta};

/// Absent until the heal has owed every document without body state.
pub const META_BODY_HEAL: &str = "sync.body_heal";

/// Owes a body pull to every live note and journal holding no body state,
/// once per install. A document still queued in the outbox is left out: the
/// server holds no body for it yet. Answers how many it owed.
pub fn owe_unread_documents(conn: &Connection) -> Result<usize, StorageError> {
    if read_meta(conn, META_BODY_HEAL)?.is_some() {
        return Ok(0);
    }
    let txn = conn.unchecked_transaction().map_err(failed)?;
    let ids = {
        let mut statement = txn
            .prepare(
                "SELECT id FROM (
                   SELECT id FROM notes WHERE deleted_at IS NULL
                   UNION SELECT id FROM journal_entries WHERE deleted_at IS NULL
                 ) AS live
                 WHERE NOT EXISTS (SELECT 1 FROM sync_cursors WHERE scope = 'crdt:' || live.id)
                   AND NOT EXISTS (SELECT 1 FROM yjs_updates
                                   WHERE doc_id IN (live.id, 'local.' || live.id))
                   AND NOT EXISTS (SELECT 1 FROM yjs_snapshots
                                   WHERE doc_id IN (live.id, 'local.' || live.id))
                   AND NOT EXISTS (SELECT 1 FROM outbox WHERE item_id = live.id)
                 ORDER BY id",
            )
            .map_err(failed)?;
        statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(failed)?
            .collect::<Result<Vec<String>, _>>()
            .map_err(failed)?
    };
    for id in &ids {
        body_debt::owe(&txn, id)?;
    }
    write_meta(&txn, META_BODY_HEAL, "done")?;
    txn.commit().map_err(failed)?;
    Ok(ids.len())
}

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}
