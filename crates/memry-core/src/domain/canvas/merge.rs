//! The inbound half of `canvas`: desktop's `CanvasHandler.applyUpsert`
//! (`apps/desktop/src/main/sync/item-handlers/canvas-handler.ts`), rule for
//! rule.
//!
//! - **No scene, no apply** (D5). A payload without a string `scene` never
//!   overwrites the local drawing.
//! - **A create needs a `vaultId`**, or desktop would never list it.
//! - **§6.3.1's gate decides**, through [`task_merge::document_gate`], so the
//!   equal-clock identical skip (§6.5.2 P4) is the one every type uses.
//! - **A concurrent clock over a different scene keeps both drawings.** The
//!   local scene is copied to a new canvas titled `<title> (conflict copy)`,
//!   owned by the same note, under a fresh clock of this device's, and queued
//!   for push. The remote scene then wins under the merged clock. Identical
//!   scenes merge the clocks and copy nothing. A tombstoned local row has no
//!   drawing to save (desktop's file is gone), so it is revived without a copy.
//! - **An absent key keeps the local value.** `title`, `folder`, `icon` and
//!   `ownerNoteId` absent from the remote mean an older client that never
//!   stated them, and `null` is a real clear. `vaultId` always stays local.
//!
//! The copy and the overwrite are one transaction, as desktop's are. The copy
//! is the one outbox row an inbound apply writes: it is a new item no peer has,
//! not a re-push of the merged one (§6.5.2 P3).
//!
//! Deletes are not here. [`crate::sync::apply`]'s tombstone path already lets
//! only a local clock strictly after the delete keep the item (#2198, #2409).

use rusqlite::Connection;
use serde_json::{Value, json};

use crate::api::errors::StorageError;
use crate::domain::notes::{failed, insert_local, next_clock, object};
use crate::domain::saved_filters::mint_id;
use crate::domain::task_merge::{self, Gate};
use crate::domain::tasks::Inbound;
use crate::storage::repositories::schema::Object;
use crate::storage::repositories::sync_items::{self, ApplyOutcome, InboundRecord};
use crate::storage::repositories::{Change, StoredPayload};
use crate::sync::clock::VectorClock;
use crate::sync::outbox;

use super::ITEM_TYPE;

/// The keys an older client may leave out, which then keep the local value.
const KEPT_WHEN_ABSENT: [&str; 4] = ["title", "folder", "icon", "ownerNoteId"];

/// Applies one inbound `canvas` record. `clock_device` is this device's clock
/// id, which only a conflict copy needs.
pub fn apply_remote(
    conn: &Connection,
    record: &InboundRecord,
    now_ms: i64,
    clock_device: Option<&str>,
) -> Result<Inbound, StorageError> {
    let remote = match StoredPayload::parse(&record.payload_json) {
        Ok(remote) if record.deleted_at.is_none() => remote,
        _ => return task_merge::wholesale(conn, record, now_ms),
    };
    let Some(remote_scene) = remote.object().get("scene").and_then(Value::as_str) else {
        return Ok(Inbound::Skipped);
    };

    let tx = conn.unchecked_transaction().map_err(failed)?;
    let local = sync_items::load(&tx, ITEM_TYPE, &record.item_id)?
        .and_then(|row| Some((row.payload?, row.deleted_at.is_none())))
        .and_then(|(raw, live)| Some((StoredPayload::parse(&raw).ok()?, live)));
    let Some((local, live)) = local else {
        if !remote.object().get("vaultId").is_some_and(Value::is_string) {
            return Ok(Inbound::Skipped);
        }
        return finish(tx, record, now_ms);
    };

    let merged_clock = match task_merge::document_gate(&tx, record)? {
        Gate::Skip => return Ok(Inbound::Skipped),
        Gate::Wholesale => None,
        Gate::Merge { merged_clock, .. } => Some(merged_clock),
    };
    let local_scene = local.object().get("scene").and_then(Value::as_str);
    if merged_clock.is_some() && live && local_scene.is_some_and(|scene| scene != remote_scene) {
        let device = clock_device.ok_or_else(|| StorageError::Failed {
            what: format!(
                "canvas {} diverged and this pull has no device clock id for its conflict copy",
                record.item_id
            ),
        })?;
        write_conflict_copy(&tx, local.object(), device, now_ms)?;
    }

    let changes = kept_changes(local.object(), remote.object(), merged_clock.as_ref())?;
    let merged = InboundRecord {
        payload_json: remote.merge(&changes),
        ..record.clone()
    };
    finish(tx, &merged, now_ms)
}

/// The remote payload's edits that keep what desktop keeps: an absent
/// [`KEPT_WHEN_ABSENT`] key, the local `vaultId`, and the merged clock.
fn kept_changes(
    local: &Object,
    remote: &Object,
    merged_clock: Option<&VectorClock>,
) -> Result<Vec<(&'static str, Change)>, StorageError> {
    let mut changes: Vec<(&'static str, Change)> = KEPT_WHEN_ABSENT
        .into_iter()
        .filter(|key| !remote.contains_key(*key))
        .filter_map(|key| Some((key, Change::Set(local.get(key)?.clone()))))
        .collect();
    if let Some(vault_id) = local.get("vaultId").filter(|value| value.is_string())
        && remote.get("vaultId") != Some(vault_id)
    {
        changes.push(("vaultId", Change::Set(vault_id.clone())));
    }
    if let Some(clock) = merged_clock {
        let clock = serde_json::to_value(clock).map_err(|error| StorageError::Failed {
            what: format!("clock will not serialise: {error}"),
        })?;
        changes.push(("clock", Change::Set(clock)));
    }
    Ok(changes)
}

/// `createConflictCopy`: the losing local drawing as a new canvas, queued.
fn write_conflict_copy(
    tx: &Connection,
    local: &Object,
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    let title = local
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("Canvas");
    let copy_id = mint_id();
    let payload = object(json!({
        "id": copy_id,
        "vaultId": local.get("vaultId"),
        "title": format!("{title} (conflict copy)"),
        "scene": local.get("scene"),
        "folder": local.get("folder"),
        "icon": null,
        "ownerNoteId": local.get("ownerNoteId"),
        "clock": next_clock(&Object::new(), device_id)?,
        "deletedAt": null,
    }));
    insert_local(tx, ITEM_TYPE, &copy_id, payload, now_ms)?;
    outbox::enqueue(tx, &outbox::Change::upsert(ITEM_TYPE, &copy_id), now_ms)?;
    Ok(())
}

fn finish(
    tx: rusqlite::Transaction<'_>,
    record: &InboundRecord,
    now_ms: i64,
) -> Result<Inbound, StorageError> {
    let outcome = sync_items::apply_remote_in(&tx, record, now_ms)?;
    tx.commit().map_err(failed)?;
    Ok(match outcome {
        ApplyOutcome::Applied => Inbound::Applied,
        ApplyOutcome::Corrupt { reason } => Inbound::Corrupt { reason },
        // `task_activity` is the only expiring type and the store has no skip.
        ApplyOutcome::Skipped | ApplyOutcome::Expired => Inbound::Skipped,
    })
}
