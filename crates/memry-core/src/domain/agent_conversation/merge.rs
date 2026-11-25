//! The inbound half of `agent_conversation`: Electron's
//! `AgentConversationHandler.applyUpsert`
//! (`apps/desktop/src/main/sync/item-handlers/agent-conversation-handler.ts:86-187`),
//! with the title sealed at rest ([`crate::crypto::agent_payload`]).
//!
//! - **A remote Electron's schema refuses is refused** before the gate and
//!   nothing is written ([`refuses`] over [`NOT_NULL`]); the pull ledgers it,
//!   as Electron records it `schema_invalid` (chapter 13 §13.2.3).
//! - **§6.3.1's gate decides.** An equal clock compares the local payload
//!   with its title opened, the payload a push would send (§6.5.2 P4). No local record, or a remote that dominates,
//!   stores the remote with its title sealed. A dominating local record skips.
//! - **Concurrent clocks merge field by field** over [`SYNCABLE_FIELDS`]
//!   (§6.3, [`crate::sync::field_merge`]): the local title is opened first so
//!   both sides compare plain values, and a winning title is sealed again.
//!   A local record with no `fieldClocks` seeds every field from its document
//!   clock (`:140-142`). `updatedAt` is the later of the two, and `deletedAt`
//!   is the remote's, else the local one (`:167-168`). The union clock is
//!   stored and re-queued (§6.5.2 P3); Electron skips the write when
//!   no field changed (`:171`), which leaves its clock behind the peer's, so
//!   this core stores the union clock either way, as `task` and `project` do.
//!   `vaultId` is no merged field: [`server_vault::merged_vault_id`] keeps the
//!   local one unless the remote states the bound server id (#5784), on this
//!   path and over a dominating remote alike, so a peer that stored a
//!   conversation before its writer's restamp takes the restamp and a remote
//!   stating the pre-bind id never moves a conversation off the bound id.
//! - **No key installed**: Electron skips the record (`:92-100`), which loses
//!   it once the cursor moves. Here the plain remote is stored and marked
//!   sealed-pending until `Vault::set_at_rest_key` seals it. On a concurrent
//!   branch a sealed local title stays sealed; if the remote title wins, or
//!   the local one was already pending, the record is stored pending. A
//!   winning title that is absent keeps the stored one, and with it the
//!   local record's pending mark, key or no key.
//! - **A local title that does not open under the installed key** (sealed
//!   under another key, an unknown envelope version, altered bytes) is an
//!   error before the gate, so the pull records the remote corrupt and the
//!   local record stays as it is: Electron throws on it too, and replacing
//!   it would lose a value an earlier key may still open.
//!
//! A delete is [`crate::sync::apply`]'s tombstone path: it applies unless the
//! local clock is strictly after the delete's (`:190-210`).

use rusqlite::Connection;
use serde_json::{Value, json};

use crate::api::errors::StorageError;
use crate::crypto::agent_envelope::{AtRestKey, SealError};
use crate::crypto::agent_payload::{open_object, seal_object};
use crate::domain::agent_records::{parse_object, refuses, store_inbound};
use crate::domain::notes::failed as sql_failed;
use crate::domain::task_merge::{self, Gate};
use crate::domain::tasks::Inbound;
use crate::storage::nested_tx;
use crate::storage::repositories::projectors::agent::{is_sealed_pending, set_sealed_pending};
use crate::storage::repositories::schema::Object;
use crate::storage::repositories::sync_items::{self, InboundRecord};
use crate::storage::repositories::{Change, StoredPayload};
use crate::sync::field_merge::{init_all_field_clocks, merge_fields};
use crate::sync::server_vault;

use super::{ITEM_TYPE, NOT_NULL, SYNCABLE_FIELDS};

/// Applies one inbound `agent_conversation` record.
pub fn apply_remote(
    conn: &Connection,
    record: &InboundRecord,
    key: &AtRestKey,
    now_ms: i64,
) -> Result<Inbound, StorageError> {
    if record.deleted_at.is_some() {
        return store_inbound(conn, record, key, now_ms);
    }
    let remote = parse_object(record)?;
    if refuses(ITEM_TYPE, &remote, &NOT_NULL) {
        return Ok(Inbound::Refused);
    }
    let pending = is_sealed_pending(conn, ITEM_TYPE, &record.item_id)?;
    let opened = opened_local(conn, &record.item_id, pending, key)?;
    let (local, merged_clock) = match task_merge::document_gate_with(conn, record, |local| {
        opened.clone().unwrap_or(local)
    })? {
        Gate::Wholesale => {
            let record = in_merged_vault(conn, record, opened.as_ref(), &remote)?;
            return store_inbound(conn, &record, key, now_ms);
        }
        Gate::Skip => return Ok(Inbound::Skipped),
        Gate::Merge {
            local,
            merged_clock,
            ..
        } => (local.object().clone(), merged_clock),
    };
    let stored_title = local.get("title").cloned();
    let local = opened.unwrap_or(local);

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
    // An absent winning title leaves the stored one as it is, plain when the
    // local record was pending. With no key a winning title is plain when the
    // local record was pending or the remote's title won.
    let pending = match seal_object(ITEM_TYPE, &mut winners, key) {
        Ok(()) => pending && !winners.contains_key("title"),
        Err(SealError::KeyUnavailable) => {
            pending
                || winners
                    .get("title")
                    .is_some_and(|title| Some(title) != stored_title.as_ref())
        }
        Err(error) => return Err(failed(&format!("title will not seal: {error}"))),
    };

    let number = |object: &Object, name: &str| object.get(name).and_then(Value::as_i64);
    let updated_at = number(&local, "updatedAt").max(number(&remote, "updatedAt"));
    let deleted_at = number(&remote, "deletedAt").or(number(&local, "deletedAt"));
    let mut changes: Vec<(&str, Change)> = SYNCABLE_FIELDS
        .iter()
        .filter_map(|field| Some((*field, Change::Set(winners.get(*field)?.clone()))))
        .collect();
    if let Some(vault_id) = server_vault::merged_vault_id(conn, &local, &remote)? {
        changes.push(("vaultId", Change::Set(vault_id)));
    }
    changes.push(("clock", Change::Set(as_json(&merged_clock)?)));
    changes.push((
        "fieldClocks",
        Change::Set(as_json(&result.merged_field_clocks)?),
    ));
    changes.push(("updatedAt", Change::Set(json!(updated_at))));
    changes.push(("deletedAt", Change::Set(json!(deleted_at))));
    let transaction = nested_tx::begin(conn).map_err(sql_failed)?;
    set_sealed_pending(&transaction, ITEM_TYPE, &record.item_id, pending)?;
    task_merge::write_merged_in(&transaction, record, &changes, now_ms)?;
    transaction.commit().map_err(sql_failed)?;
    // The title is sealed at rest, so its values stay out of the feed.
    let conflicts = result
        .conflicts
        .into_iter()
        .map(|mut conflict| {
            if conflict.field == "title" {
                conflict.local_value = None;
                conflict.remote_value = None;
                conflict.merged_value = None;
            }
            conflict
        })
        .collect();
    Ok(Inbound::Merged {
        conflicted_fields: result.conflicted_fields,
        conflicts,
    })
}

/// `record` stating [`server_vault::merged_vault_id`]'s `vaultId` over `local`, so a dominating
/// remote that states a pre-bind id leaves a stored conversation on the bound id (#5784).
fn in_merged_vault(
    conn: &Connection,
    record: &InboundRecord,
    local: Option<&Object>,
    remote: &Object,
) -> Result<InboundRecord, StorageError> {
    let vault_id = match local {
        Some(local) => server_vault::merged_vault_id(conn, local, remote)?,
        None => None,
    };
    let Some(vault_id) = vault_id.filter(|id| remote.get("vaultId") != Some(id)) else {
        return Ok(record.clone());
    };
    let mut remote = remote.clone();
    remote.insert("vaultId".to_owned(), vault_id);
    Ok(InboundRecord {
        payload_json: Value::Object(remote).to_string(),
        ..record.clone()
    })
}

/// The stored local payload with its title opened, `None` when there is no
/// local payload to merge against. A sealed-pending title is plain already,
/// and with no key installed a sealed title stays sealed (it then compares
/// unequal to the remote). A title that does not open under the installed key
/// is an error, so the pull records the remote corrupt instead of merging
/// over a value it cannot read.
fn opened_local(
    conn: &Connection,
    id: &str,
    pending: bool,
    key: &AtRestKey,
) -> Result<Option<Object>, StorageError> {
    let Some(raw) = sync_items::load(conn, ITEM_TYPE, id)?.and_then(|row| row.payload) else {
        return Ok(None);
    };
    let Ok(stored) = StoredPayload::parse(&raw) else {
        return Ok(None);
    };
    let mut local = stored.object().clone();
    if pending {
        return Ok(Some(local));
    }
    match open_object(ITEM_TYPE, &mut local, key) {
        Ok(()) => Ok(Some(local)),
        Err(SealError::KeyUnavailable) => Ok(Some(stored.object().clone())),
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
