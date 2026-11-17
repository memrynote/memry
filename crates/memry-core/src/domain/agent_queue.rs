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

/// Runs `source` in one transaction and, under [`Queue::Outbox`], queues
/// `change` in it ([`outbox::commit`]).
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
    transaction.commit().map_err(failed)?;
    Ok(value)
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
    let mut queued = 0;
    for id in ids {
        let Some(row) = sync_items::load(&transaction, item_type, id)? else {
            continue;
        };
        if is_queued(&transaction, item_type, id)?
            || (item_type == agent_message::ITEM_TYPE && !is_final(&transaction, id)?)
        {
            continue;
        }
        let change = if row.deleted_at.is_some() {
            Change::delete(item_type, id)
        } else {
            Change::upsert(item_type, id)
        };
        queued += usize::from(outbox::enqueue(&transaction, &change, now_ms)?.is_some());
    }
    transaction.commit().map_err(failed)?;
    Ok(queued)
}

/// Queues every conversation of `vault_id`, deleted ones included, and every
/// final message of those conversations, as Electron's
/// `backfillAgentChatRows` does when the account turns paid. A deleted
/// conversation is queued too, so one the server holds from an earlier paid
/// period is deleted there. Returns how many it queued.
pub fn backfill(conn: &Connection, vault_id: &str, now_ms: i64) -> Result<usize, StorageError> {
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
    Ok(
        enqueue_existing(conn, agent_conversation::ITEM_TYPE, &conversations, now_ms)?
            + enqueue_existing(conn, agent_message::ITEM_TYPE, &messages, now_ms)?,
    )
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
