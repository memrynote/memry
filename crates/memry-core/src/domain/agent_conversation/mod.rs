//! Agent conversations: the `agent_conversation` sync type
//! (`AgentConversationSyncPayloadSchema`, `packages/contracts/src/sync-payloads.ts:699-711`;
//! chapter 13 §13.7.26), the record half of desktop's
//! `apps/desktop/src/main/agent/storage/conversation-store.ts`. Step 28
//! (#3545) builds the agent on these functions.
//!
//! The payload is Electron's `plainLocalPayload`
//! (`apps/desktop/src/main/sync/item-handlers/agent-conversation-handler.ts:38-56`):
//! `{vaultId, title, backend, backendModel, trustList, pinned, clock,
//! fieldClocks, createdAt, updatedAt, deletedAt}`, instants in epoch
//! milliseconds. `title` is stored sealed ([`crate::crypto::agent_payload`]),
//! so every write and every read of a sealed title needs the vault key
//! ([`AgentError::SealerUnavailable`] without one). The five
//! [`SYNCABLE_FIELDS`] merge field by field ([`merge`]).

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
use crate::domain::task_merge::next_field_clocks;
use crate::storage::repositories::Change;
use crate::storage::repositories::projectors::agent::set_sealed_pending;
use crate::storage::repositories::schema::Object;
use crate::sync::outbox;

/// The sync type of a conversation record.
pub const ITEM_TYPE: &str = "agent_conversation";

/// `AGENT_CONVERSATION_SYNCABLE_FIELDS`
/// (`packages/sync-client/src/agent-conversation-fields.ts:1-7`).
pub const SYNCABLE_FIELDS: [&str; 5] = ["title", "backend", "backendModel", "trustList", "pinned"];

/// The keys `AgentConversationSyncPayloadSchema` does not mark `.nullable()`
/// (`packages/contracts/src/sync-payloads.ts:699-711`): a remote with `null`
/// in one is refused.
pub const NOT_NULL: [&str; 9] = [
    "vaultId",
    "title",
    "backend",
    "trustList",
    "pinned",
    "clock",
    "fieldClocks",
    "createdAt",
    "updatedAt",
];

/// One live conversation, its title opened. Instants are epoch milliseconds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Conversation {
    pub id: String,
    pub vault_id: String,
    pub title: String,
    pub backend: String,
    pub backend_model: Option<String>,
    pub trust_list: Vec<String>,
    pub pinned: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Copy)]
pub struct NewConversation<'a> {
    pub vault_id: &'a str,
    pub title: &'a str,
    pub backend: &'a str,
    pub backend_model: Option<&'a str>,
}

/// The fields an update changes; `None` keeps a field.
#[derive(Debug, Clone, Copy, Default)]
pub struct ConversationPatch<'a> {
    pub title: Option<&'a str>,
    pub backend: Option<&'a str>,
    pub backend_model: Option<Option<&'a str>>,
    pub trust_list: Option<&'a [String]>,
    pub pinned: Option<bool>,
}

/// Creates a conversation with an empty trust list, unpinned, and queues it.
pub fn create(
    conn: &Connection,
    key: &AtRestKey,
    new: &NewConversation<'_>,
    device_id: &str,
    now_ms: i64,
) -> Result<Conversation, AgentError> {
    let id = mint_id();
    let mut payload = object(json!({
        "vaultId": new.vault_id,
        "title": new.title,
        "backend": new.backend,
        "backendModel": new.backend_model,
        "trustList": [],
        "pinned": false,
        "clock": next_clock(&Object::new(), device_id)?,
        "fieldClocks": next_field_clocks(
            &Object::new(),
            &SYNCABLE_FIELDS,
            &SYNCABLE_FIELDS,
            device_id,
        )?,
        "createdAt": now_ms,
        "updatedAt": now_ms,
        "deletedAt": null,
    }));
    let conversation = from_payload(&id, &payload);
    seal_object(ITEM_TYPE, &mut payload, key)?;
    outbox::commit(
        conn,
        &outbox::Change::upsert(ITEM_TYPE, &id),
        now_ms,
        |tx| insert_local(tx, ITEM_TYPE, &id, payload, now_ms),
    )?;
    Ok(conversation)
}

/// Changes the patched fields of a live conversation, ticks its clock and
/// each changed field's clock, and queues it. An empty patch writes nothing.
pub fn update_fields(
    conn: &Connection,
    key: &AtRestKey,
    id: &str,
    patch: &ConversationPatch<'_>,
    device_id: &str,
    now_ms: i64,
) -> Result<Conversation, AgentError> {
    let current = get(conn, key, id)?.ok_or_else(|| StorageError::NotFound {
        what: format!("no agent conversation {id}"),
    })?;
    let mut changed = Object::new();
    if let Some(title) = patch.title {
        changed.insert("title".to_owned(), json!(title));
    }
    if let Some(backend) = patch.backend {
        changed.insert("backend".to_owned(), json!(backend));
    }
    if let Some(model) = patch.backend_model {
        changed.insert("backendModel".to_owned(), json!(model));
    }
    if let Some(trust_list) = patch.trust_list {
        changed.insert("trustList".to_owned(), json!(trust_list));
    }
    if let Some(pinned) = patch.pinned {
        changed.insert("pinned".to_owned(), json!(pinned));
    }
    if changed.is_empty() {
        return Ok(current);
    }
    let touched: Vec<&str> = SYNCABLE_FIELDS
        .into_iter()
        .filter(|field| changed.contains_key(*field))
        .collect();
    seal_object(ITEM_TYPE, &mut changed, key)?;
    outbox::commit(conn, &outbox::Change::upsert(ITEM_TYPE, id), now_ms, |tx| {
        let stored = live(tx, ITEM_TYPE, id, "agent conversation")?;
        let mut changes: Vec<(&'static str, Change)> = SYNCABLE_FIELDS
            .into_iter()
            .filter_map(|field| Some((field, Change::Set(changed.get(field)?.clone()))))
            .collect();
        let field_clocks =
            next_field_clocks(stored.object(), &SYNCABLE_FIELDS, &touched, device_id)?;
        changes.push(("fieldClocks", Change::Set(field_clocks)));
        changes.push(("updatedAt", Change::set(now_ms)));
        // A sealed title replaces a sealed-pending one, and the title is the
        // only sealed key.
        if changed.contains_key("title") {
            set_sealed_pending(tx, ITEM_TYPE, id, false)?;
        }
        desktop_records::edit(tx, ITEM_TYPE, id, &stored, changes, device_id, now_ms).map(drop)
    })?;
    get(conn, key, id)?.ok_or_else(|| {
        AgentError::Storage(StorageError::Failed {
            what: format!("agent conversation {id} did not read back"),
        })
    })
}

/// Deletes a conversation and queues the delete, stating `deletedAt` as
/// Electron's soft delete does. `false` when there was none. Its messages are
/// their own records.
pub fn soft_delete(
    conn: &Connection,
    id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<bool, StorageError> {
    if !is_live(conn, id)? {
        return Ok(false);
    }
    outbox::commit(conn, &outbox::Change::delete(ITEM_TYPE, id), now_ms, |tx| {
        let stored = live(tx, ITEM_TYPE, id, "agent conversation")?;
        let changes = vec![
            ("deletedAt", Change::set(now_ms)),
            ("updatedAt", Change::set(now_ms)),
        ];
        desktop_records::tombstone(tx, ITEM_TYPE, id, &stored, changes, device_id, now_ms)
    })?;
    Ok(true)
}

/// One live conversation by id.
pub fn get(
    conn: &Connection,
    key: &AtRestKey,
    id: &str,
) -> Result<Option<Conversation>, AgentError> {
    if !is_live(conn, id)? {
        return Ok(None);
    }
    Ok(opened(conn, ITEM_TYPE, id, key)?.map(|payload| from_payload(id, &payload)))
}

/// Every live conversation of `vault_id`, most recently updated first
/// (`listByVault`).
pub fn list(
    conn: &Connection,
    key: &AtRestKey,
    vault_id: &str,
) -> Result<Vec<Conversation>, AgentError> {
    let ids: Vec<String> = {
        let mut statement = conn
            .prepare_cached(
                "SELECT id FROM agent_conversations WHERE vault_id = ?1 AND deleted_at IS NULL
                 ORDER BY updated_at DESC, id",
            )
            .map_err(failed)?;
        statement
            .query_map(params![vault_id], |row| row.get(0))
            .map_err(failed)?
            .collect::<Result<_, _>>()
            .map_err(failed)?
    };
    let mut conversations = Vec::with_capacity(ids.len());
    for id in ids {
        conversations.extend(get(conn, key, &id)?);
    }
    Ok(conversations)
}

fn is_live(conn: &Connection, id: &str) -> Result<bool, StorageError> {
    conn.query_row(
        "SELECT COUNT(*) FROM agent_conversations WHERE id = ?1 AND deleted_at IS NULL",
        params![id],
        |row| row.get::<_, i64>(0),
    )
    .map(|count| count > 0)
    .map_err(failed)
}

fn from_payload(id: &str, payload: &Object) -> Conversation {
    let text = |key: &str| payload.get(key).and_then(Value::as_str).map(str::to_owned);
    let number = |key: &str| payload.get(key).and_then(Value::as_i64).unwrap_or(0);
    Conversation {
        id: id.to_owned(),
        vault_id: text("vaultId").unwrap_or_default(),
        title: text("title").unwrap_or_default(),
        backend: text("backend").unwrap_or_default(),
        backend_model: text("backendModel"),
        trust_list: payload
            .get("trustList")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default(),
        pinned: payload
            .get("pinned")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        created_at: number("createdAt"),
        updated_at: number("updatedAt"),
    }
}

#[cfg(test)]
mod tests;
