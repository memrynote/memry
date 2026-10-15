//! Chapter 06 §6.11.2 and §6.11.4 on an inbound `task`: `fields` joins per
//! key by its own versions on every branch (wholesale, merge and skip), and a
//! join that leaves the remote behind is re-pushed.
//!
//! Twin of the `joinVersionedMap` / `owesHeal` steps in desktop's
//! `apps/desktop/src/main/sync/item-handlers/task-handler.ts`. It runs after
//! [`super::task_merge::apply_remote_merged`], which stores the remote's map
//! on a wholesale apply and keeps the local one on a merge or a skip; this
//! step writes the join over whichever it kept.
//!
//! A heal is the one enqueue an inbound apply makes, and §6.11.4 bounds it:
//! never on an insert, a skip, a remote `null` or a merge with conflicts
//! (§6.5.2 P3), so two clients never ping-pong. It ticks this device into
//! the document clock, which is what lets the re-push pass the server's
//! replay check, and names no changed field, so no field clock ticks.

use rusqlite::Connection;
use serde_json::Value;

use crate::api::errors::StorageError;
use crate::domain::notes::{failed, next_clock};
use crate::storage::repositories::sync_items::{self, InboundRecord};
use crate::storage::repositories::{Change, StoredPayload};
use crate::sync::field_merge::canonical_json;
use crate::sync::outbox;
use crate::sync::versioned;

use super::{ITEM_TYPE, Inbound};

/// The local `fields` before the apply: `None` when there is no live local
/// row (an insert), `Some(None)` when the row holds no map.
pub(super) fn local_fields(
    conn: &Connection,
    record: &InboundRecord,
) -> Result<Option<Option<Value>>, StorageError> {
    let Some(row) = sync_items::load(conn, ITEM_TYPE, &record.item_id)? else {
        return Ok(None);
    };
    if row.deleted_at.is_some() {
        return Ok(None);
    }
    let Some(payload) = row.payload.and_then(|raw| StoredPayload::parse(&raw).ok()) else {
        return Ok(None);
    };
    Ok(Some(payload.object().get("fields").cloned()))
}

/// Writes the join of `local` and the remote's map over what the apply kept,
/// and heals when §6.11.4 owes one.
pub(super) fn join_after_apply(
    conn: &Connection,
    record: &InboundRecord,
    local: Option<Option<Value>>,
    inbound: &Inbound,
    clock_device: Option<&str>,
    now_ms: i64,
) -> Result<(), StorageError> {
    let Some(local) = local else {
        return Ok(());
    };
    if record.deleted_at.is_some() || matches!(inbound, Inbound::Corrupt { .. }) {
        return Ok(());
    }
    let Ok(remote) = StoredPayload::parse(&record.payload_json) else {
        return Ok(());
    };
    let joined = versioned::join_map(local.as_ref(), remote.object().get("fields"));
    let stored = sync_items::load(conn, ITEM_TYPE, &record.item_id)?
        .and_then(|row| row.payload)
        .and_then(|raw| StoredPayload::parse(&raw).ok());
    let Some(stored) = stored else {
        return Ok(());
    };
    let kept = stored.object().get("fields").cloned();
    let rewrite = joined.value.is_some()
        && joined.value.as_ref().map(canonical_json) != kept.as_ref().map(canonical_json);
    let heal = joined.remote_behind
        && match inbound {
            Inbound::Applied => true,
            Inbound::Merged { conflicted_fields } => conflicted_fields.is_empty(),
            Inbound::Skipped | Inbound::Corrupt { .. } => false,
        };

    let mut changes: Vec<(&str, Change)> = Vec::new();
    if rewrite && let Some(value) = joined.value {
        changes.push(("fields", Change::Set(value)));
    }
    let heal_device = clock_device.filter(|_| heal);
    if let Some(device) = heal_device {
        changes.push(("clock", Change::Set(next_clock(stored.object(), device)?)));
    }
    if changes.is_empty() {
        return Ok(());
    }
    let write = |tx: &Connection| {
        sync_items::apply_local_edit_in(tx, ITEM_TYPE, &record.item_id, &changes, now_ms)
    };
    if heal_device.is_some() {
        outbox::commit(
            conn,
            &outbox::Change::upsert(ITEM_TYPE, &record.item_id),
            now_ms,
            write,
        )?
        .acknowledge();
    } else {
        let transaction = conn.unchecked_transaction().map_err(failed)?;
        write(&transaction)?;
        transaction.commit().map_err(failed)?;
    }
    Ok(())
}
