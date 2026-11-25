//! The inbound half of `canvas`: desktop's `CanvasHandler.applyUpsert`
//! (`apps/desktop/src/main/sync/item-handlers/canvas-handler.ts`), rule for
//! rule.
//!
//! - **A record desktop's schema refuses is refused** before anything else (a
//!   key of the wrong type, `scene` included, a `null` the schema has no room
//!   for, a clock tick that is not a safe integer): a local canvas stays as it
//!   is, and the pull ledgers it ([`crate::sync::refused_items`]).
//! - **No scene, no apply** (D5). A payload without a `scene` is skipped and
//!   never overwrites the local drawing.
//! - **A create needs a `vaultId`**, or desktop would never list it.
//! - **§6.3.1's gate decides**, through [`task_merge::document_gate`], so the
//!   equal-clock identical skip (§6.5.2 P4) is the one every type uses.
//! - **A concurrent clock over a different scene keeps both drawings.** The
//!   local scene is copied to a new canvas titled `<title> (conflict copy)`,
//!   owned by the same note, in the merge's vault
//!   ([`server_vault::merged_vault_id`]), under a fresh clock of this device's,
//!   and queued for push. The remote scene then wins under the merged clock. Identical
//!   scenes merge the clocks and copy nothing. A tombstoned local row has no
//!   drawing to save (desktop's file is gone), so it gets no copy; it stays
//!   deleted while its `delete` is queued and is revived once that delete has
//!   been pushed ([`requeue::queued_tombstone`], the rule every merge keeps).
//! - **An absent key keeps the local value.** `title`, `folder`, `icon` and
//!   `ownerNoteId` absent from the remote mean an older client that never
//!   stated them, and `null` is a real clear. `vaultId` stays local unless the
//!   remote states the bound server id ([`server_vault::merged_vault_id`], #5669).
//!   A fast-forward that keeps the bound id over the remote's pushes it once
//!   ([`server_vault::repush_kept`], #5812).
//! - **A restamp contests only `vaultId`** ([`server_vault::restamp`], which
//!   desktop's handler does not know). A concurrent remote restamp whose base
//!   this live canvas is strictly after leaves this canvas as it is under the
//!   merged clock, re-queued; a local restamp whose base the remote is strictly
//!   after takes the remote's canvas with no conflict copy.
//!
//! The copy and the overwrite are one transaction, as desktop's are. The copy
//! is a new item no peer has; the merged original is re-queued beside it
//! (§6.5.2 P3, [`crate::sync::hardening::requeue`]).
//!
//! Deletes are not here. [`crate::sync::apply`]'s tombstone path already lets
//! only a local clock strictly after the delete keep the item (#2198, #2409).

use rusqlite::Connection;
use serde_json::{Value, json};

use crate::api::errors::StorageError;
use crate::domain::desktop_records::fails_desktop_schema;
use crate::domain::notes::{clock_in, failed, insert_local, next_clock, object};
use crate::domain::saved_filters::mint_id;
use crate::domain::task_merge::{self, Gate};
use crate::domain::tasks::Inbound;
use crate::storage::nested_tx;
use crate::storage::repositories::schema::Object;
use crate::storage::repositories::sync_items::{self, ApplyOutcome, InboundRecord};
use crate::storage::repositories::{Change, StoredPayload};
use crate::sync::clock::VectorClock;
use crate::sync::hardening::requeue;
use crate::sync::{outbox, server_vault};

use super::ITEM_TYPE;

/// The schema keys `CanvasSyncPayloadSchema` refuses `null` for
/// (`packages/contracts/src/sync-payloads.ts:187-207`).
const NOT_NULL: [&str; 4] = ["id", "vaultId", "scene", "clock"];

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
    if fails_desktop_schema(ITEM_TYPE, remote.object(), &NOT_NULL) {
        return Ok(Inbound::Refused);
    }
    let Some(remote_scene) = remote.object().get("scene").and_then(Value::as_str) else {
        return Ok(Inbound::Skipped);
    };

    let tx = nested_tx::begin(conn).map_err(failed)?;
    let local = sync_items::load(&tx, ITEM_TYPE, &record.item_id)?
        .and_then(|row| Some((row.payload?, row.deleted_at.is_none())))
        .and_then(|(raw, live)| Some((StoredPayload::parse(&raw).ok()?, live)));
    let Some((local, live)) = local else {
        if !remote.object().get("vaultId").is_some_and(Value::is_string) {
            return Ok(Inbound::Skipped);
        }
        return finish(tx, record, now_ms, false, remote.object(), clock_device);
    };

    let merged_clock = match task_merge::document_gate(&tx, record)? {
        Gate::Skip => return Ok(Inbound::Skipped),
        Gate::Wholesale => None,
        Gate::Merge { merged_clock, .. } => Some(merged_clock),
    };
    let restamped_remote = live
        && merged_clock.is_some()
        && server_vault::restamp_superseded(remote.object(), &clock_in(local.object())?);
    let restamped_local =
        server_vault::restamp_superseded(local.object(), &clock_in(remote.object())?);
    let vault_id = server_vault::merged_vault_id(&tx, local.object(), remote.object())?;
    let local_scene = local.object().get("scene").and_then(Value::as_str);
    if merged_clock.is_some()
        && live
        && !restamped_remote
        && !restamped_local
        && local_scene.is_some_and(|scene| scene != remote_scene)
    {
        let device = clock_device.ok_or_else(|| StorageError::Failed {
            what: format!(
                "canvas {} diverged and this pull has no device clock id for its conflict copy",
                record.item_id
            ),
        })?;
        write_conflict_copy(&tx, local.object(), vault_id.as_ref(), device, now_ms)?;
    }

    let winner = if restamped_remote { &local } else { &remote };
    let changes = kept_changes(
        local.object(),
        winner.object(),
        vault_id,
        merged_clock.as_ref(),
    )?;
    let merged = InboundRecord {
        payload_json: winner.merge(&changes),
        ..record.clone()
    };
    finish(
        tx,
        &merged,
        now_ms,
        merged_clock.is_some(),
        remote.object(),
        clock_device,
    )
}

/// The remote payload's edits that keep what desktop keeps: an absent
/// [`KEPT_WHEN_ABSENT`] key, the merge's `vault_id`, and the merged clock.
fn kept_changes(
    local: &Object,
    remote: &Object,
    vault_id: Option<Value>,
    merged_clock: Option<&VectorClock>,
) -> Result<Vec<(&'static str, Change)>, StorageError> {
    let mut changes: Vec<(&'static str, Change)> = KEPT_WHEN_ABSENT
        .into_iter()
        .filter(|key| !remote.contains_key(*key))
        .filter_map(|key| Some((key, Change::Set(local.get(key)?.clone()))))
        .collect();
    if let Some(vault_id) = vault_id
        && remote.get("vaultId") != Some(&vault_id)
    {
        changes.push(("vaultId", Change::Set(vault_id)));
    }
    if let Some(clock) = merged_clock {
        let clock = serde_json::to_value(clock).map_err(|error| StorageError::Failed {
            what: format!("clock will not serialise: {error}"),
        })?;
        changes.push(("clock", Change::Set(clock)));
    }
    Ok(changes)
}

/// `createConflictCopy`: the losing local drawing as a new canvas, queued, in the merge's vault:
/// a copy on the stored pre-bind id would be hidden on every fresh device (#5784, desktop #5788).
fn write_conflict_copy(
    tx: &Connection,
    local: &Object,
    vault_id: Option<&Value>,
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
        "vaultId": vault_id.or(local.get("vaultId")),
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

/// Stores `record`, the `remote` with the merge's edits. A merge is re-queued; a fast-forward that
/// kept the server vault id over the remote's is pushed ([`server_vault::repush_kept`]).
fn finish(
    tx: nested_tx::NestedTx<'_>,
    record: &InboundRecord,
    now_ms: i64,
    merged: bool,
    remote: &Object,
    clock_device: Option<&str>,
) -> Result<Inbound, StorageError> {
    let kept;
    let record = if merged {
        kept = InboundRecord {
            deleted_at: requeue::queued_tombstone(&tx, record)?,
            ..record.clone()
        };
        &kept
    } else {
        record
    };
    let outcome = sync_items::apply_remote_in(&tx, record, now_ms)?;
    if merged && outcome == ApplyOutcome::Applied {
        requeue::requeue(&tx, ITEM_TYPE, &record.item_id, now_ms)?;
    } else if outcome == ApplyOutcome::Applied {
        server_vault::repush_kept(
            &tx,
            ITEM_TYPE,
            &record.item_id,
            remote,
            clock_device,
            now_ms,
        )?;
    }
    tx.commit().map_err(failed)?;
    Ok(match outcome {
        ApplyOutcome::Applied => Inbound::Applied,
        ApplyOutcome::Corrupt { reason } => Inbound::Corrupt { reason },
        ApplyOutcome::Refused => Inbound::Refused,
        // `task_activity` is the only expiring type and the store has no skip.
        ApplyOutcome::Skipped | ApplyOutcome::Expired => Inbound::Skipped,
    })
}
