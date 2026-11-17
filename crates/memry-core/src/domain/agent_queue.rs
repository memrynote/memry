//! When an agent record reaches the outbox (Step 28, #3545). Electron writes
//! every agent row locally and pushes it only while the account is paid
//! (`apps/desktop/src/main/agent/sync/entitlement-gate.ts:17-27`), and only
//! once a message is final. A write here takes a [`Queue`]: the shell's
//! entitlement gate picks it. When the account turns paid, [`backfill`]
//! queues what was written meanwhile (`agent/sync/backfill.ts:20-58`).
//!
//! No sync sweep queues a record that has no outbox row: the manifest
//! re-upload (`sync::hardening::manifest::REUPLOADED`) names neither agent
//! type, so a [`Queue::LocalOnly`] row stays on this device until
//! [`backfill`] or a later queued write sends it.
//!
//! A push deletes the outbox rows it sent, so [`backfill`] cannot tell a sent
//! record from one never queued. It runs only while the vault's marker says a
//! record may be waiting: a [`Queue::LocalOnly`] write and a turn to unpaid
//! ([`mark_backfill_pending`]) set it, and a backfill clears it in its own
//! transaction. A vault with no marker row is pending, so the rows an Electron
//! build wrote (it queued none) are backfilled once.

use rusqlite::{Connection, OptionalExtension, params};

use crate::api::errors::StorageError;
use crate::domain::notes::failed;
use crate::domain::{agent_conversation, agent_message};
use crate::storage::repositories::sync_items;
use crate::sync::outbox::{self, Change};

/// Whether a write queues its record for the push.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Queue {
    /// Queue it in the transaction that writes it.
    Outbox,
    /// Write it on this device only: the account is not paid, or the message
    /// is still streaming.
    LocalOnly,
}

/// The `meta` row a backfill writes. Absent means a backfill is pending.
const BACKFILL_DONE: &str = "agent.backfill_done";

/// Runs `source` in one transaction and, under [`Queue::Outbox`], queues
/// `change` in it ([`outbox::commit`]). Under [`Queue::LocalOnly`] it marks
/// the vault's backfill pending in the same transaction.
pub(crate) fn commit<T>(
    conn: &Connection,
    queue: Queue,
    change: &Change,
    now_ms: i64,
    source: impl FnOnce(&Connection) -> Result<T, StorageError>,
) -> Result<T, StorageError> {
    if queue == Queue::Outbox {
        return outbox::commit(conn, change, now_ms, source).map(outbox::Durable::acknowledge);
    }
    let transaction = conn.unchecked_transaction().map_err(failed)?;
    let value = source(&transaction)?;
    mark_backfill_pending(&transaction)?;
    transaction.commit().map_err(failed)?;
    Ok(value)
}

/// Runs a streaming write in one transaction: stored on this device, never
/// queued, and asking for no backfill, which skips a message until it is final.
pub(crate) fn commit_streaming<T>(
    conn: &Connection,
    source: impl FnOnce(&Connection) -> Result<T, StorageError>,
) -> Result<T, StorageError> {
    let transaction = conn.unchecked_transaction().map_err(failed)?;
    let value = source(&transaction)?;
    transaction.commit().map_err(failed)?;
    Ok(value)
}

/// Makes the next [`backfill`] of this vault run: the account turned unpaid,
/// and the server may not hold what this device writes next.
pub fn mark_backfill_pending(conn: &Connection) -> Result<(), StorageError> {
    conn.execute("DELETE FROM meta WHERE key = ?1", params![BACKFILL_DONE])
        .map(drop)
        .map_err(failed)
}

/// Queues the current state of each listed record that is not queued yet, in
/// one transaction: an upsert, or a delete for a tombstone. A message that is
/// not final is skipped, since a push never sends one. Returns how many it
/// queued, so a second run over the same rows queues nothing.
pub fn enqueue_existing(
    conn: &Connection,
    item_type: &str,
    ids: &[String],
    now_ms: i64,
) -> Result<usize, StorageError> {
    let transaction = conn.unchecked_transaction().map_err(failed)?;
    let queued = enqueue(&transaction, item_type, ids, now_ms)?;
    transaction.commit().map_err(failed)?;
    Ok(queued)
}

fn enqueue(
    conn: &Connection,
    item_type: &str,
    ids: &[String],
    now_ms: i64,
) -> Result<usize, StorageError> {
    let mut queued = 0;
    for id in ids {
        let Some(row) = sync_items::load(conn, item_type, id)? else {
            continue;
        };
        if is_queued(conn, item_type, id)?
            || (item_type == agent_message::ITEM_TYPE && !is_final(conn, id)?)
        {
            continue;
        }
        let change = if row.deleted_at.is_some() {
            Change::delete(item_type, id)
        } else {
            Change::upsert(item_type, id)
        };
        queued += usize::from(outbox::enqueue(conn, &change, now_ms)?.is_some());
    }
    Ok(queued)
}

/// Queues every conversation of `vault_id`, deleted ones included, and every
/// final message of those conversations, as Electron's
/// `backfillAgentChatRows` does when the account turns paid. A deleted
/// conversation is queued too, so one the server holds from an earlier paid
/// period is deleted there. Runs only while the backfill is pending, and
/// clears it in the same transaction. Returns how many it queued.
pub fn backfill(conn: &Connection, vault_id: &str, now_ms: i64) -> Result<usize, StorageError> {
    let transaction = conn.unchecked_transaction().map_err(failed)?;
    let pending: bool = transaction
        .query_row(
            "SELECT NOT EXISTS(SELECT 1 FROM meta WHERE key = ?1)",
            params![BACKFILL_DONE],
            |row| row.get(0),
        )
        .map_err(failed)?;
    if !pending {
        return Ok(0);
    }
    let conn = &transaction;
    let conversations = ids(
        conn,
        "SELECT id FROM agent_conversations WHERE vault_id = ?1 ORDER BY created_at, id",
        vault_id,
    )?;
    let messages = ids(
        conn,
        "SELECT id FROM agent_messages
         WHERE conversation_id IN (SELECT id FROM agent_conversations WHERE vault_id = ?1)
         ORDER BY created_at, id",
        vault_id,
    )?;
    let queued = enqueue(conn, agent_conversation::ITEM_TYPE, &conversations, now_ms)?
        + enqueue(conn, agent_message::ITEM_TYPE, &messages, now_ms)?;
    conn.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES (?1, '1')",
        params![BACKFILL_DONE],
    )
    .map_err(failed)?;
    transaction.commit().map_err(failed)?;
    Ok(queued)
}

fn ids(conn: &Connection, sql: &str, vault_id: &str) -> Result<Vec<String>, StorageError> {
    let mut statement = conn.prepare(sql).map_err(failed)?;
    statement
        .query_map(params![vault_id], |row| row.get(0))
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)
}

fn is_queued(conn: &Connection, item_type: &str, id: &str) -> Result<bool, StorageError> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM outbox WHERE item_type = ?1 AND item_id = ?2)",
        params![item_type, id],
        |row| row.get(0),
    )
    .map_err(failed)
}

fn is_final(conn: &Connection, id: &str) -> Result<bool, StorageError> {
    let status: Option<String> = conn
        .query_row(
            "SELECT status FROM agent_messages WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .optional()
        .map_err(failed)?;
    Ok(status.is_some_and(|status| agent_message::TERMINAL_STATUSES.contains(&status.as_str())))
}

#[cfg(test)]
#[path = "agent_queue_tests.rs"]
mod tests;
