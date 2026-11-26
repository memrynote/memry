//! Storing an accepted snapshot push: the snapshot row and the prune of the
//! server rows it absorbed, in one transaction.

use rusqlite::{Connection, params};

use super::{crdt_to_storage, failed, stable_watermark};
use crate::api::errors::StorageError;
use crate::crdt::epoch::{Epoch, HeldBody};
use crate::crdt::update_log::{self, Namespace};
use crate::storage::nested_tx;
use crate::sync::body_debt;

/// Stores the pushed snapshot and prunes the local rows it absorbed.
///
/// One transaction. A kill between the two would otherwise leave a pruned log
/// with no snapshot, which is the one shape that loses body state.
///
/// Returns the watermark written and how many rows were pruned, or `None`,
/// storing nothing and owing a pull, when the body moved off `epoch`.
/// What the push response answered for the bytes it stored.
pub(super) struct PushedSnapshot<'a> {
    pub(super) epoch: Epoch,
    pub(super) state: &'a [u8],
    pub(super) answered: Option<i64>,
    pub(super) revision: Option<&'a str>,
}

pub(super) fn store_pushed_snapshot(
    conn: &Connection,
    doc_id: &str,
    pushed: PushedSnapshot<'_>,
) -> Result<Option<(i64, usize)>, StorageError> {
    let txn = nested_tx::begin(conn).map_err(failed)?;
    let Some(body) = HeldBody::check(&txn, doc_id, pushed.epoch).map_err(crdt_to_storage)? else {
        body_debt::owe(&txn, doc_id)?;
        txn.commit().map_err(failed)?;
        return Ok(None);
    };

    let existing = update_log::snapshot(&txn, Namespace::Server, doc_id)
        .map_err(crdt_to_storage)?
        .map(|row| row.last_seq);
    let watermark = stable_watermark(existing, pushed.answered);

    // #5849: stamped under the writer that absorbs the server rows, never below a stamp it
    // replaces (as `compact::fold_compacted`), so no search watermark passes it.
    let replaced: Option<i64> = txn
        .query_row(
            "SELECT MAX(stamp) FROM (
               SELECT created_at AS stamp FROM yjs_updates WHERE doc_id = ?1 AND seq <= ?2
               UNION ALL SELECT compacted_at FROM yjs_snapshots WHERE doc_id = ?1)",
            params![Namespace::Server.row_id(doc_id), watermark],
            |row| row.get(0),
        )
        .map_err(failed)?;
    let compacted_at = replaced
        .unwrap_or_default()
        .max(crate::api::tasks_write::now_ms());

    // §7.13.4: the revision the server answered, never an invented token.
    body.put_server_snapshot(pushed.state, watermark, pushed.revision, compacted_at)
        .map_err(crdt_to_storage)?;

    let pruned = txn
        .execute(
            "DELETE FROM yjs_updates WHERE doc_id = ?1 AND seq <= ?2",
            params![Namespace::Server.row_id(doc_id), watermark],
        )
        .map_err(failed)?;

    txn.commit().map_err(failed)?;
    Ok(Some((watermark, pruned)))
}
