//! The inbound half of `agent_message`: Electron's
//! `AgentMessageHandler.applyUpsert`
//! (`apps/desktop/src/main/sync/item-handlers/agent-message-handler.ts:132-185`),
//! with the content and attachments sealed at rest
//! ([`crate::crypto::agent_payload`]).
//!
//! - **A message is written once.** An id this device already holds keeps
//!   the local record whatever the remote says, checked first (`:179-183`):
//!   Electron skips an identical message and logs a conflict for a different
//!   one, and this core has no log, so both are `Skipped`. A row with no
//!   payload (metadata only) holds no message yet and takes the remote.
//! - **A remote Electron's schema refuses is skipped** and nothing is written
//!   ([`refuses`] over [`NOT_NULL`]; chapter 13 §13.2.3).
//! - **Only a terminal status is a record** (`:138`): any other status,
//!   absent included, is an error, so the pull records the item corrupt and
//!   stores none of its payload.
//! - A new id stores the remote with its sealed keys sealed.
//! - **No key installed**: Electron skips the record (`:140-148`), which loses
//!   it once the cursor moves. Here the plain remote is stored and projects as
//!   `sealed_pending` until `Vault::set_at_rest_key` seals it.
//! - **No parent check**: Electron defers a message whose conversation is
//!   missing (`:108-121`, `:156`); this core has no orphan repair, and a message that
//!   lands first is read once its conversation does.
//!
//! A delete is [`crate::sync::apply`]'s tombstone path: it applies unless the
//! local clock is strictly after the delete's (`:187-210`).

use rusqlite::Connection;
use serde_json::Value;

use crate::api::errors::StorageError;
use crate::crypto::agent_envelope::AtRestKey;
use crate::domain::agent_records::{parse_object, refuses, seal_inbound};
use crate::domain::task_merge;
use crate::domain::tasks::Inbound;
use crate::storage::repositories::sync_items::{self, InboundRecord};

use super::{ITEM_TYPE, NOT_NULL, TERMINAL_STATUSES};

/// Applies one inbound `agent_message` record.
pub fn apply_remote(
    conn: &Connection,
    record: &InboundRecord,
    key: &AtRestKey,
    now_ms: i64,
) -> Result<Inbound, StorageError> {
    if record.deleted_at.is_some() {
        return task_merge::wholesale(conn, record, now_ms);
    }
    let held = sync_items::load(conn, ITEM_TYPE, &record.item_id)?
        .is_some_and(|row| row.payload.is_some());
    if held {
        return Ok(Inbound::Skipped);
    }
    let remote = parse_object(record)?;
    if refuses(ITEM_TYPE, &remote, &NOT_NULL) {
        return Ok(Inbound::Skipped);
    }
    let status = remote.get("status").and_then(Value::as_str);
    if !status.is_some_and(|status| TERMINAL_STATUSES.contains(&status)) {
        return Err(StorageError::Failed {
            what: format!("{ITEM_TYPE} status {status:?} is not terminal"),
        });
    }
    task_merge::wholesale(conn, &seal_inbound(record, key)?, now_ms)
}
