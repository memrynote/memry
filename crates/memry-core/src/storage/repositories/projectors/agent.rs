//! `agent_conversation` and `agent_message` (`AgentConversationSyncPayloadSchema`
//! and `AgentMessageSyncPayloadSchema`, `packages/contracts/src/sync-payloads.ts:699-724`;
//! chapter 13 §13.7.26-27; migration `0029`).
//!
//! The payload this reads is the stored one, whose sealed keys hold envelope
//! text ([`crate::crypto::agent_payload`]). A sealed column takes that text,
//! the format Electron's columns hold. A sealed-pending record (one a pull
//! stored while no vault key was installed, [`is_sealed_pending`]) leaves its
//! sealed columns empty, so no plaintext reaches a projection column. A
//! `deletedAt` in the payload reads as deleted, as a tombstone does.
//!
//! `role` and `status` read as any text: a value a newer build adds projects
//! here, and the message merge decides which statuses it accepts.

use rusqlite::{Connection, params};
use serde_json::Value;

use super::super::schema::{Field, Kind, Object, ProjectionError, read_fields};
use super::{ItemContext, failed, flag, json, number, text, text_or_default};
use crate::api::errors::StorageError;

const CONVERSATION_FIELDS: &[Field] = &[
    Field::opt_null("vaultId", Kind::Text),
    Field::opt_null("title", Kind::Text),
    Field::opt_null("backend", Kind::Text),
    Field::opt_null("backendModel", Kind::Text),
    Field::opt_null("trustList", Kind::TextArray),
    Field::opt_null("pinned", Kind::Bool),
    Field::opt_null("clock", Kind::Clock),
    Field::opt_null("fieldClocks", Kind::ClockMap),
    Field::opt_null("createdAt", Kind::Number),
    Field::opt_null("updatedAt", Kind::Number),
    Field::opt_null("deletedAt", Kind::Number),
];

const MESSAGE_FIELDS: &[Field] = &[
    Field::opt_null("conversationId", Kind::Text),
    Field::opt_null("role", Kind::Text),
    Field::opt_null("content", Kind::Any),
    Field::opt_null("attachments", Kind::Any),
    Field::opt_null("toolCallId", Kind::Text),
    Field::opt_null("status", Kind::Text),
    Field::opt_null("clock", Kind::Clock),
    Field::opt_null("createdAt", Kind::Number),
    Field::opt_null("updatedAt", Kind::Number),
    Field::opt_null("deletedAt", Kind::Number),
];

pub const CONVERSATION: &str = "agent_conversation";
pub const MESSAGE: &str = "agent_message";

pub fn read_agent_conversation(parsed: &Object) -> Result<Object, ProjectionError> {
    read_fields(CONVERSATION, parsed, CONVERSATION_FIELDS)
}

pub fn read_agent_message(parsed: &Object) -> Result<Object, ProjectionError> {
    read_fields(MESSAGE, parsed, MESSAGE_FIELDS)
}

/// Whether the stored payload of `(item_type, item_id)` holds its sealed keys
/// plain (migration `0029`'s `agent_sealed_pending`). Decided when the payload
/// is written, never from its shape.
pub fn is_sealed_pending(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
) -> Result<bool, StorageError> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM agent_sealed_pending WHERE item_type = ?1 AND item_id = ?2)",
        params![item_type, item_id],
        |row| row.get(0),
    )
    .map_err(failed)
}

/// Records whether the payload a write is storing for `(item_type, item_id)`
/// holds its sealed keys plain. Every write that replaces an agent record's
/// sealed keys calls it in the same transaction, before it projects.
pub fn set_sealed_pending(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
    pending: bool,
) -> Result<(), StorageError> {
    let sql = if pending {
        "INSERT OR IGNORE INTO agent_sealed_pending (item_type, item_id) VALUES (?1, ?2)"
    } else {
        "DELETE FROM agent_sealed_pending WHERE item_type = ?1 AND item_id = ?2"
    };
    conn.execute(sql, params![item_type, item_id])
        .map_err(failed)?;
    Ok(())
}

pub fn project_agent_conversation(
    conn: &Connection,
    item: ItemContext<'_>,
    view: &Object,
) -> Result<(), StorageError> {
    let pending = is_sealed_pending(conn, CONVERSATION, item.item_id)?;
    conn.execute(
        "INSERT INTO agent_conversations (
             id, vault_id, title, backend, backend_model, trust_list, pinned,
             created_at, updated_at, deleted_at, synced_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(id) DO UPDATE SET
             vault_id = excluded.vault_id,
             title = excluded.title,
             backend = excluded.backend,
             backend_model = excluded.backend_model,
             trust_list = excluded.trust_list,
             pinned = excluded.pinned,
             created_at = excluded.created_at,
             updated_at = excluded.updated_at,
             deleted_at = excluded.deleted_at,
             synced_at = excluded.synced_at",
        params![
            item.item_id,
            text(view, "vaultId"),
            sealed(view, "title", pending),
            text_or_default(view, "backend", ""),
            text(view, "backendModel"),
            json(view, "trustList").unwrap_or_else(|| "[]".to_owned()),
            flag(view, "pinned").unwrap_or(0),
            number(view, "createdAt"),
            number(view, "updatedAt"),
            item.deleted_at.or_else(|| number(view, "deletedAt")),
            item.synced_at,
        ],
    )
    .map_err(failed)?;
    Ok(())
}

pub fn project_agent_message(
    conn: &Connection,
    item: ItemContext<'_>,
    view: &Object,
) -> Result<(), StorageError> {
    let pending = is_sealed_pending(conn, MESSAGE, item.item_id)?;
    conn.execute(
        "INSERT INTO agent_messages (
             id, conversation_id, role, content, attachments, tool_call_id, status,
             created_at, updated_at, deleted_at, synced_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(id) DO UPDATE SET
             conversation_id = excluded.conversation_id,
             role = excluded.role,
             content = excluded.content,
             attachments = excluded.attachments,
             tool_call_id = excluded.tool_call_id,
             status = excluded.status,
             created_at = excluded.created_at,
             updated_at = excluded.updated_at,
             deleted_at = excluded.deleted_at,
             synced_at = excluded.synced_at",
        params![
            item.item_id,
            text_or_default(view, "conversationId", ""),
            text_or_default(view, "role", ""),
            sealed(view, "content", pending),
            sealed(view, "attachments", pending),
            text(view, "toolCallId"),
            text_or_default(view, "status", ""),
            number(view, "createdAt"),
            number(view, "updatedAt"),
            item.deleted_at.or_else(|| number(view, "deletedAt")),
            item.synced_at,
        ],
    )
    .map_err(failed)?;
    Ok(())
}

/// A sealed column: the envelope text, or empty while the record is
/// sealed-pending or the key is absent.
fn sealed(view: &Object, key: &str, pending: bool) -> String {
    view.get(key)
        .filter(|_| !pending)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}
