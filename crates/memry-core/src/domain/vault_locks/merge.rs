//! The inbound half of `vault_lock`: Electron's `VaultLockHandler.applyUpsert`
//! (`apps/desktop/src/main/sync/item-handlers/vault-lock-handler.ts`), rule
//! for rule.
//!
//! - **A record desktop's schema refuses is refused**, and the local record
//!   left alone: a key of the wrong type (`targetKind: 5`, `target: 5`,
//!   `locked: "yes"`), a `null` in any key, or a clock tick that is not a safe
//!   integer. The pull ledgers it ([`crate::sync::refused_items`]).
//! - **A kind this build does not know is skipped**, and the local record left
//!   alone: guessing what it locks could block writes or leave a target the
//!   peer meant to protect writable. An absent `targetKind` is not unknown.
//! - **A create needs `targetKind`, `target` and `locked`**: every payload
//!   field is optional, so `{}` parses, and a lock row needs all three.
//! - **§6.3.1's gate decides**, through [`task_merge::document_gate`]. A
//!   concurrent clock is last-writer-wins: the remote applies under the merged
//!   clock, as Electron's `merge` branch does.
//! - **Over a local record, only `locked` and `updatedAt` move.** The local
//!   `targetKind`, `target` and `createdAt` stay, and an absent `locked` keeps
//!   the local value. An absent `updatedAt` reads as the apply time
//!   ([`crate::storage::repositories::projectors::vault_locks`]).
//!
//! A delete is [`crate::sync::apply`]'s tombstone path unchanged: it marks the
//! row deleted, which unlocks, unless the local clock is strictly after the
//! delete's (Electron's `resolveDeleteClock` skip).

use rusqlite::Connection;
use serde_json::Value;

use crate::api::errors::StorageError;
use crate::domain::desktop_records::fails_desktop_schema;
use crate::domain::task_merge::{self, Gate};
use crate::domain::tasks::Inbound;
use crate::storage::repositories::schema::Object;
use crate::storage::repositories::sync_items::{self, InboundRecord};
use crate::storage::repositories::{Change, StoredPayload};
use crate::sync::clock::VectorClock;

use super::{ITEM_TYPE, is_known_kind};

/// `VaultLockSyncPayloadSchema` refuses `null` for every key
/// (`packages/contracts/src/sync-payloads.ts:477-484`).
const NOT_NULL: [&str; 6] = [
    "targetKind",
    "target",
    "locked",
    "clock",
    "createdAt",
    "updatedAt",
];

/// The keys a local record keeps whatever the remote says.
const KEPT_LOCAL: [&str; 3] = ["targetKind", "target", "createdAt"];

/// Applies one inbound `vault_lock` record.
pub fn apply_remote(
    conn: &Connection,
    record: &InboundRecord,
    now_ms: i64,
) -> Result<Inbound, StorageError> {
    let remote = match StoredPayload::parse(&record.payload_json) {
        Ok(remote) if record.deleted_at.is_none() => remote,
        _ => return task_merge::wholesale(conn, record, now_ms),
    };
    if fails_desktop_schema(ITEM_TYPE, remote.object(), &NOT_NULL) {
        return Ok(Inbound::Refused);
    }
    if let Some(Value::String(kind)) = remote.object().get("targetKind")
        && !is_known_kind(kind)
    {
        return Ok(Inbound::Skipped);
    }
    let local = sync_items::load(conn, ITEM_TYPE, &record.item_id)?
        .filter(|row| row.deleted_at.is_none())
        .and_then(|row| StoredPayload::parse(&row.payload?).ok());
    if local.is_none() && !is_complete(remote.object()) {
        return Ok(Inbound::Skipped);
    }
    let merged_clock = match task_merge::document_gate(conn, record)? {
        Gate::Skip => return Ok(Inbound::Skipped),
        Gate::Wholesale => None,
        Gate::Merge { merged_clock, .. } => Some(merged_clock),
    };
    let changes = kept_changes(
        local.as_ref().map(StoredPayload::object),
        remote.object(),
        merged_clock.as_ref(),
    )?;
    let merged = InboundRecord {
        payload_json: remote.merge(&changes),
        ..record.clone()
    };
    task_merge::wholesale(conn, &merged, now_ms)
}

/// Electron's insert guard: `targetKind` and `target` non-empty, `locked`
/// stated.
fn is_complete(remote: &Object) -> bool {
    let text = |key: &str| {
        remote
            .get(key)
            .and_then(Value::as_str)
            .is_some_and(|value| !value.is_empty())
    };
    text("targetKind") && text("target") && remote.get("locked").is_some_and(Value::is_boolean)
}

/// The edits to the remote payload that keep what Electron keeps over an
/// existing row, plus the merged clock.
fn kept_changes(
    local: Option<&Object>,
    remote: &Object,
    merged_clock: Option<&VectorClock>,
) -> Result<Vec<(&'static str, Change)>, StorageError> {
    let mut changes = Vec::new();
    if let Some(local) = local {
        for key in KEPT_LOCAL {
            if let Some(value) = local.get(key)
                && remote.get(key) != Some(value)
            {
                changes.push((key, Change::Set(value.clone())));
            }
        }
        if !remote.get("locked").is_some_and(Value::is_boolean)
            && let Some(value) = local.get("locked").filter(|value| value.is_boolean())
        {
            changes.push(("locked", Change::Set(value.clone())));
        }
    }
    if let Some(clock) = merged_clock {
        let clock = serde_json::to_value(clock).map_err(|error| StorageError::Failed {
            what: format!("clock will not serialise: {error}"),
        })?;
        changes.push(("clock", Change::Set(clock)));
    }
    Ok(changes)
}
