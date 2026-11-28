//! `agent_conversations` and `agent_messages` as the core stores them (`crypto::agent_payload`):
//! the payload Electron's handler pushes (`plainLocalPayload`, `agent-conversation-handler.ts:39`,
//! `agent-message-handler.ts:56`), key for key, except that each sealed key holds Electron's
//! at-rest envelope column unopened. Electron seals those columns under the vault key with the
//! chapter 04 §4.17 envelope (`agent/storage/encryption.ts`), which is what the core writes to
//! `sync_items` and its projection, so the import copies ciphertext and never holds a plaintext
//! or a key. The core opens them once Step 37 installs the vault key (`Vault::set_at_rest_key`,
//! bound by the verifier the settings importer copies). A column that is no envelope is a row
//! Electron cannot read either, and fails the import.

use memry_core::crypto::agent_envelope;
use memry_core::storage::import::ImportRecord;
use rusqlite::Row;
use serde_json::{Map, Value};

use super::records::{malformed, parse_clock, records, text};
use super::row_dumps::{column, json_column};
use super::{SourceDb, TableStats};
use crate::electron_import::vault_db::{ImportError, TableCtx, read_source_id};

/// `TERMINAL_STATUSES` (`agent/storage/types.ts:24`): the only messages Electron pushes.
const TERMINAL_STATUSES: [&str; 3] = ["completed", "cancelled", "error"];

/// A sealed column as the core stores it: the envelope text, checked but not opened.
fn sealed(
    row: &Row<'_>,
    name: &str,
    table: &'static str,
    rowid: i64,
) -> Result<Value, ImportError> {
    match text(row, name)? {
        Some(envelope) if agent_envelope::well_formed(&envelope) => Ok(Value::String(envelope)),
        _ => Err(malformed(
            table,
            rowid,
            "a sealed column is no agent envelope",
        )),
    }
}

/// A `mode: 'json'` clock column read as Electron's `parseJsonColumn(value, {})`.
fn clock(row: &Row<'_>, name: &str, table: &'static str, rowid: i64) -> Result<Value, ImportError> {
    Ok(parse_clock(text(row, name)?.as_deref(), table, rowid)?
        .unwrap_or_else(|| Value::Object(Map::new())))
}

/// `pinned`, a drizzle `mode: 'boolean'` column.
fn flag(row: &Row<'_>, name: &str, table: &'static str, rowid: i64) -> Result<Value, ImportError> {
    match column(row, name, table, rowid)? {
        Value::Number(n) => Ok(Value::Bool(n.as_f64() != Some(0.0))),
        _ => Err(malformed(table, rowid, "a boolean column is not a number")),
    }
}

pub fn agent_conversations(ctx: &mut TableCtx<'_>) -> Result<TableStats, ImportError> {
    const TABLE: &str = "agent_conversations";
    records(
        ctx,
        "SELECT rowid, id, vault_id, title_ciphertext, backend, backend_model, trust_list, pinned, \
         vector_clock, field_clocks, created_at, updated_at, deleted_at, last_synced_at \
         FROM agent_conversations",
        |row, rowid| {
            let mut payload = Map::new();
            payload.insert("vaultId".into(), column(row, "vault_id", TABLE, rowid)?);
            payload.insert(
                "title".into(),
                sealed(row, "title_ciphertext", TABLE, rowid)?,
            );
            payload.insert("backend".into(), column(row, "backend", TABLE, rowid)?);
            payload.insert(
                "backendModel".into(),
                column(row, "backend_model", TABLE, rowid)?,
            );
            let trust_list = match json_column(row, "trust_list", TABLE, rowid)? {
                Value::Null => Value::Array(Vec::new()),
                list => list,
            };
            payload.insert("trustList".into(), trust_list);
            payload.insert("pinned".into(), flag(row, "pinned", TABLE, rowid)?);
            payload.insert("clock".into(), clock(row, "vector_clock", TABLE, rowid)?);
            payload.insert(
                "fieldClocks".into(),
                clock(row, "field_clocks", TABLE, rowid)?,
            );
            for (key, name) in [
                ("createdAt", "created_at"),
                ("updatedAt", "updated_at"),
                ("deletedAt", "deleted_at"),
            ] {
                payload.insert(key.into(), column(row, name, TABLE, rowid)?);
            }
            let synced_at =
                match column(row, "last_synced_at", TABLE, rowid)? {
                    Value::Null => None,
                    Value::Number(n) => Some(n.as_i64().ok_or_else(|| {
                        malformed(TABLE, rowid, "last_synced_at is not an integer")
                    })?),
                    _ => return Err(malformed(TABLE, rowid, "last_synced_at is not an integer")),
                };
            Ok(ImportRecord {
                item_type: "agent_conversation",
                item_id: read_source_id(row, SourceDb::Data, TABLE, "id")?,
                payload: super::js_json::stringify(&Value::Object(payload)),
                synced_at,
            })
        },
    )
}

/// A message still streaming when Electron quit is kept as Electron keeps it, and counted:
/// Electron never pushes it (`buildPushPayload` returns null), and nothing queues it here.
pub fn agent_messages(ctx: &mut TableCtx<'_>) -> Result<TableStats, ImportError> {
    const TABLE: &str = "agent_messages";
    let mut open = 0;
    let mut stats = records(
        ctx,
        "SELECT rowid, id, conversation_id, role, content_ciphertext, attachments_ciphertext, \
         tool_call_id, status, vector_clock, created_at, updated_at, deleted_at \
         FROM agent_messages",
        |row, rowid| {
            let status = column(row, "status", TABLE, rowid)?;
            if !status
                .as_str()
                .is_some_and(|status| TERMINAL_STATUSES.contains(&status))
            {
                open += 1;
            }
            let mut payload = Map::new();
            payload.insert(
                "conversationId".into(),
                column(row, "conversation_id", TABLE, rowid)?,
            );
            payload.insert("role".into(), column(row, "role", TABLE, rowid)?);
            payload.insert(
                "content".into(),
                sealed(row, "content_ciphertext", TABLE, rowid)?,
            );
            payload.insert(
                "attachments".into(),
                sealed(row, "attachments_ciphertext", TABLE, rowid)?,
            );
            payload.insert(
                "toolCallId".into(),
                column(row, "tool_call_id", TABLE, rowid)?,
            );
            payload.insert("status".into(), status);
            payload.insert("clock".into(), clock(row, "vector_clock", TABLE, rowid)?);
            for (key, name) in [
                ("createdAt", "created_at"),
                ("updatedAt", "updated_at"),
                ("deletedAt", "deleted_at"),
            ] {
                payload.insert(key.into(), column(row, name, TABLE, rowid)?);
            }
            Ok(ImportRecord {
                item_type: "agent_message",
                item_id: read_source_id(row, SourceDb::Data, TABLE, "id")?,
                payload: super::js_json::stringify(&Value::Object(payload)),
                synced_at: None,
            })
        },
    )?;
    if open > 0 {
        stats.notices.push(("unfinishedAgentMessages", open));
    }
    Ok(stats)
}
