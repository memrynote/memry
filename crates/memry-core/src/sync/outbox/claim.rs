//! [`claim`]: which queued rows a wave may send now, and in what order.

use rusqlite::{Connection, params};

use super::{OP_CRDT_UPDATE, OP_DELETE, OutboxRow, failed};
use crate::api::errors::StorageError;

/// Reads the claimable rows in send order: **CRDT rows first, grouped by
/// document, then record rows** (§A.2).
///
/// The order is what stops a body edit landing after its own note's delete.
/// It is expressed in SQL rather than sorted afterwards so that `limit`
/// truncates the tail of the wave and never its head.
///
/// **A document's rows go in order or not at all.** While one CRDT row waits
/// (deferred or parked), the document's later rows are not claimed: a peer given
/// them without it holds pending structs that may never heal.
///
/// **A parent's delete waits while any record row of a cascaded child type is
/// queued** ([`crate::sync::hardening::orphans::CASCADED`]), deferred or not: a
/// project delete that overtook its tasks' Inbox moves would let a peer's orphan
/// repair tombstone them. Any row of the child type holds it, since a moved child
/// no longer names the parent, and a row queued after the delete counts too: an
/// edit re-queues a moved task under a new id. No cascaded type is also a parent,
/// so the hold has no cycle. It ends when the child-type rows leave the queue
/// (accepted, retired, or answered replay or delete-wins); a child the server keeps
/// rejecting keeps the delete queued with it, which delays the delete and loses
/// nothing.
///
/// `skip_docs` are documents this wave already deferred: their rows stay out of
/// the rest of the wave, whatever the clock says.
pub fn claim(
    conn: &Connection,
    now_ms: i64,
    limit: usize,
    skip_docs: &[String],
) -> Result<Vec<OutboxRow>, StorageError> {
    let skipped = serde_json::to_string(skip_docs).map_err(|error| StorageError::Failed {
        what: format!("could not encode the skipped documents: {error}"),
    })?;
    let cascades = crate::sync::hardening::orphans::CASCADED
        .map(|(child, _, parent)| format!("('{parent}', '{child}')"))
        .join(", ");
    let mut statement = conn
        .prepare(&format!(
            "SELECT id, item_type, item_id, op, payload, enqueued_at,
                    attempt_count, last_error, next_attempt_at
               FROM outbox
              WHERE (next_attempt_at IS NULL OR next_attempt_at <= ?1)
                AND NOT (op = ?2 AND EXISTS (
                      SELECT 1 FROM outbox held
                       WHERE held.op = ?2 AND held.item_id = outbox.item_id
                         AND held.id < outbox.id AND held.next_attempt_at > ?1))
                AND NOT (op = ?2 AND item_id IN (SELECT value FROM json_each(?4)))
                AND NOT (op = ?5 AND EXISTS (
                      SELECT 1 FROM outbox child
                       WHERE child.op <> ?2
                         AND (outbox.item_type, child.item_type) IN (VALUES {cascades})))
              ORDER BY (op <> ?2),
                       CASE WHEN op = ?2 THEN item_id ELSE '' END,
                       id
              LIMIT ?3"
        ))
        .map_err(failed)?;
    let rows = statement
        .query_map(
            params![now_ms, OP_CRDT_UPDATE, limit as i64, skipped, OP_DELETE],
            |row| {
                Ok(OutboxRow {
                    id: row.get(0)?,
                    item_type: row.get(1)?,
                    item_id: row.get(2)?,
                    op: row.get(3)?,
                    payload: row.get(4)?,
                    enqueued_at: row.get(5)?,
                    attempt_count: row.get(6)?,
                    last_error: row.get(7)?,
                    next_attempt_at: row.get(8)?,
                })
            },
        )
        .map_err(failed)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(failed)?;
    Ok(rows)
}
