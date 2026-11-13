//! Agent messages: the `agent_message` sync type
//! (`AgentMessageSyncPayloadSchema`, `packages/contracts/src/sync-payloads.ts:713-724`;
//! chapter 13 §13.7.27), the record half of desktop's
//! `apps/desktop/src/main/agent/storage/message-store.ts`. Step 28 (#3545)
//! builds the agent on these functions.
//!
//! A message is immutable once written and only a terminal one (`completed`,
//! `cancelled`, `error`) is a record: Electron pushes no other
//! (`agent-message-handler.ts:257`) and refuses one inbound (`:138`). A
//! streaming message stays in the agent's memory until it ends. `content`
//! and `attachments` are stored sealed ([`crate::crypto::agent_payload`]).
//! No check that the conversation exists: a message lands before its
//! conversation does, as migration `0028` explains.

pub mod merge;

use rusqlite::{Connection, params};
use serde_json::{Value, json};

use crate::api::errors::StorageError;
use crate::crypto::agent_envelope::AtRestKey;
use crate::crypto::agent_payload::seal_object;
use crate::domain::agent_records::{AgentError, opened};
use crate::domain::desktop_records::{self, live};
use crate::domain::notes::{failed, insert_local, next_clock, object};
use crate::domain::saved_filters::mint_id;
use crate::storage::repositories::Change;
use crate::storage::repositories::schema::Object;
use crate::sync::outbox;

/// The sync type of a message record.
pub const ITEM_TYPE: &str = "agent_message";

/// `TERMINAL_STATUSES` (`apps/desktop/src/main/agent/storage/types.ts:24-28`).
pub const TERMINAL_STATUSES: [&str; 3] = ["completed", "cancelled", "error"];

/// The keys `AgentMessageSyncPayloadSchema` does not mark `.nullable()`
/// (`packages/contracts/src/sync-payloads.ts:713-724`): a remote with `null`
/// in one is refused.
pub const NOT_NULL: [&str; 8] = [
    "conversationId",
    "role",
    "content",
    "attachments",
    "status",
    "clock",
    "createdAt",
    "updatedAt",
];

/// One live message, its content and attachments opened. Instants are epoch
/// milliseconds.
#[derive(Debug, Clone, PartialEq)]
pub struct Message {
    pub id: String,
    pub conversation_id: String,
    pub role: String,
    pub content: Value,
    pub attachments: Value,
    pub tool_call_id: Option<String>,
    pub status: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Copy)]
pub struct NewMessage<'a> {
    /// The caller's id, or `None` to mint one (`append`'s `input.id`).
    pub id: Option<&'a str>,
    pub conversation_id: &'a str,
    pub role: &'a str,
    pub content: &'a Value,
    pub attachments: &'a Value,
    pub tool_call_id: Option<&'a str>,
    pub status: &'a str,
}

/// Stores a terminal message and queues it. A status that is not terminal is
/// `Invalid`: nothing would ever sync it.
pub fn append(
    conn: &Connection,
    key: &AtRestKey,
    new: &NewMessage<'_>,
    device_id: &str,
    now_ms: i64,
) -> Result<Message, AgentError> {
    if !TERMINAL_STATUSES.contains(&new.status) {
        return Err(StorageError::Invalid {
            what: format!("agent message status `{}` is not terminal", new.status),
        }
        .into());
    }
    let id = new.id.map_or_else(mint_id, str::to_owned);
    let mut payload = object(json!({
        "conversationId": new.conversation_id,
        "role": new.role,
        "content": new.content,
        "attachments": new.attachments,
        "toolCallId": new.tool_call_id,
        "status": new.status,
        "clock": next_clock(&Object::new(), device_id)?,
        "createdAt": now_ms,
        "updatedAt": now_ms,
        "deletedAt": null,
    }));
    let message = from_payload(&id, &payload);
    seal_object(ITEM_TYPE, &mut payload, key)?;
    outbox::commit(
        conn,
        &outbox::Change::upsert(ITEM_TYPE, &id),
        now_ms,
        |tx| insert_local(tx, ITEM_TYPE, &id, payload, now_ms),
    )?;
    Ok(message)
}

/// The live messages of a conversation, oldest first (`listByConversation`).
pub fn get_by_conversation(
    conn: &Connection,
    key: &AtRestKey,
    conversation_id: &str,
) -> Result<Vec<Message>, AgentError> {
    let ids: Vec<String> = {
        let mut statement = conn
            .prepare_cached(
                "SELECT id FROM agent_messages WHERE conversation_id = ?1 AND deleted_at IS NULL
                 ORDER BY created_at, id",
            )
            .map_err(failed)?;
        statement
            .query_map(params![conversation_id], |row| row.get(0))
            .map_err(failed)?
            .collect::<Result<_, _>>()
            .map_err(failed)?
    };
    let mut messages = Vec::with_capacity(ids.len());
    for id in ids {
        if let Some(payload) = opened(conn, ITEM_TYPE, &id, key)? {
            messages.push(from_payload(&id, &payload));
        }
    }
    Ok(messages)
}

/// Deletes a message and queues the delete, stating `deletedAt`. `false`
/// when there was none.
pub fn delete(
    conn: &Connection,
    id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<bool, StorageError> {
    let live_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM agent_messages WHERE id = ?1 AND deleted_at IS NULL",
            params![id],
            |row| row.get(0),
        )
        .map_err(failed)?;
    if live_count == 0 {
        return Ok(false);
    }
    outbox::commit(conn, &outbox::Change::delete(ITEM_TYPE, id), now_ms, |tx| {
        let stored = live(tx, ITEM_TYPE, id, "agent message")?;
        let changes = vec![
            ("deletedAt", Change::set(now_ms)),
            ("updatedAt", Change::set(now_ms)),
        ];
        desktop_records::tombstone(tx, ITEM_TYPE, id, &stored, changes, device_id, now_ms)
    })?;
    Ok(true)
}

fn from_payload(id: &str, payload: &Object) -> Message {
    let text = |key: &str| payload.get(key).and_then(Value::as_str).map(str::to_owned);
    let number = |key: &str| payload.get(key).and_then(Value::as_i64).unwrap_or(0);
    Message {
        id: id.to_owned(),
        conversation_id: text("conversationId").unwrap_or_default(),
        role: text("role").unwrap_or_default(),
        content: payload.get("content").cloned().unwrap_or(Value::Null),
        attachments: payload
            .get("attachments")
            .cloned()
            .unwrap_or_else(|| json!([])),
        tool_call_id: text("toolCallId"),
        status: text("status").unwrap_or_default(),
        created_at: number("createdAt"),
        updated_at: number("updatedAt"),
    }
}

#[cfg(test)]
mod tests;
