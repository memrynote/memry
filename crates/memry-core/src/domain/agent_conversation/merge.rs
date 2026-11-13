//! The inbound half of `agent_conversation`: Electron's
//! `AgentConversationHandler.applyUpsert`
//! (`apps/desktop/src/main/sync/item-handlers/agent-conversation-handler.ts:85-185`),
//! with the title sealed at rest ([`crate::crypto::agent_payload`]).
//!
//! - **§6.3.1's gate decides.** No local record, or a remote that dominates,
//!   stores the remote with its title sealed. A dominating local record skips.
//! - **Concurrent clocks merge field by field** over [`SYNCABLE_FIELDS`]
//!   (§6.3, [`crate::sync::field_merge`]): the local title is opened first so
//!   both sides compare plain values, and a winning title is sealed again.
//!   A local record with no `fieldClocks` seeds every field from its document
//!   clock (`:140-142`). `updatedAt` is the later of the two, and `deletedAt`
//!   is the remote's, else the local one (`:160-161`). The union clock is
//!   stored and nothing is queued (§6.5.2 P3); Electron skips the write when
//!   no field changed (`:164`), which leaves its clock behind the peer's, so
//!   this core stores the union clock either way, as `task` and `project` do.
//! - **No key installed**: Electron skips the record (`:92-100`), which loses
//!   it once the cursor moves. Here the plain remote is stored and projects
//!   as `sealed_pending` until `Vault::set_at_rest_key` seals it. On a
//!   concurrent branch a sealed local title that cannot be opened stays
//!   sealed; if the remote title wins, the plain one is stored pending.
//!
//! A delete is [`crate::sync::apply`]'s tombstone path: it applies unless the
//! local clock is strictly after the delete's (`:189-200`).

use rusqlite::Connection;
use serde_json::{Value, json};

use crate::api::errors::StorageError;
use crate::crypto::agent_envelope::{AtRestKey, SealError};
use crate::crypto::agent_payload::{open_object, seal_object};
use crate::domain::agent_records::{parse_object, seal_inbound};
use crate::domain::task_merge::{self, Gate};
use crate::domain::tasks::Inbound;
use crate::storage::repositories::Change;
use crate::storage::repositories::schema::Object;
use crate::storage::repositories::sync_items::InboundRecord;
use crate::sync::field_merge::{init_all_field_clocks, merge_fields};

use super::{ITEM_TYPE, SYNCABLE_FIELDS};

/// Applies one inbound `agent_conversation` record.
pub fn apply_remote(
    conn: &Connection,
    record: &InboundRecord,
    key: &AtRestKey,
    now_ms: i64,
) -> Result<Inbound, StorageError> {
    if record.deleted_at.is_some() {
        return task_merge::wholesale(conn, record, now_ms);
    }
    let sealed = seal_inbound(record, key)?;
    let (local, merged_clock) = match task_merge::document_gate(conn, record)? {
        Gate::Wholesale => return task_merge::wholesale(conn, &sealed, now_ms),
        Gate::Skip => return Ok(Inbound::Skipped),
        Gate::Merge {
            local,
            merged_clock,
            ..
        } => (local.object().clone(), merged_clock),
    };
    let remote = parse_object(record)?;
    let local = opened_local(local, key)?;

    let local_field_clocks = match local.get("fieldClocks") {
        None | Some(Value::Null) => init_all_field_clocks(
            &task_merge::stored_clock(&local)?.unwrap_or_default(),
            &SYNCABLE_FIELDS,
        ),
        Some(_) => task_merge::stored_field_clocks(&local, "local")?,
    };
    let result = merge_fields(
        &local,
        &remote,
        &local_field_clocks,
        &task_merge::stored_field_clocks(&remote, "remote")?,
        &SYNCABLE_FIELDS,
    );
    let mut winners: Object = result.merged.into_iter().collect();
    match seal_object(ITEM_TYPE, &mut winners, key) {
        Ok(()) | Err(SealError::KeyUnavailable) => {}
        Err(error) => return Err(failed(&format!("title will not seal: {error}"))),
    }

    let number = |object: &Object, name: &str| object.get(name).and_then(Value::as_i64);
    let updated_at = number(&local, "updatedAt").max(number(&remote, "updatedAt"));
    let deleted_at = number(&remote, "deletedAt").or(number(&local, "deletedAt"));
    let mut changes: Vec<(&str, Change)> = SYNCABLE_FIELDS
        .iter()
        .filter_map(|field| Some((*field, Change::Set(winners.get(*field)?.clone()))))
        .collect();
    changes.push(("clock", Change::Set(as_json(&merged_clock)?)));
    changes.push((
        "fieldClocks",
        Change::Set(as_json(&result.merged_field_clocks)?),
    ));
    changes.push(("updatedAt", Change::Set(json!(updated_at))));
    changes.push(("deletedAt", Change::Set(json!(deleted_at))));
    task_merge::write_merged(conn, record, &changes, now_ms)?;
    Ok(Inbound::Merged {
        conflicted_fields: result.conflicted_fields,
    })
}

/// The local payload with its title opened. Without a key the sealed title
/// stays as it is; a title that does not open under the installed key is an
/// error, so the pull records the remote corrupt instead of merging over a
/// value it cannot read.
fn opened_local(mut local: Object, key: &AtRestKey) -> Result<Object, StorageError> {
    match open_object(ITEM_TYPE, &mut local, key) {
        Ok(()) | Err(SealError::KeyUnavailable) => Ok(local),
        Err(error) => Err(failed(&format!("local title will not open: {error}"))),
    }
}

fn as_json<T: serde::Serialize>(value: &T) -> Result<Value, StorageError> {
    serde_json::to_value(value)
        .map_err(|error| failed(&format!("clock will not serialise: {error}")))
}

fn failed(what: &str) -> StorageError {
    StorageError::Failed {
        what: format!("{ITEM_TYPE}: {what}"),
    }
}
