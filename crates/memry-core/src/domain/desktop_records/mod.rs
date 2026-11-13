//! What `canvas_folder`, `home_page` and `sticky_draft` share (Step 16,
//! #3533): one whole-record clock, a desktop handler that keeps some local
//! keys over a newer remote, and local writes that tick that clock.
//!
//! Inbound, [`apply_kept`] is §6.3.1's document gate followed by the remote
//! payload with the [`Kept`] keys taken back from the local record, under the
//! merged clock on a concurrent branch (each handler's "last write wins").
//! Keys this build does not model ride along in the remote payload (§13.2
//! rule 3), and nothing here enqueues (§6.5.2 P3). A delete is
//! [`crate::sync::apply`]'s tombstone path unchanged: it applies unless the
//! local clock is strictly after the delete's (each handler's
//! `resolveDeleteClock` skip).
//!
//! Locally, every write is one transaction with its outbox row
//! ([`crate::sync::outbox::commit`]) and starts from the stored payload, so a
//! key a newer build wrote survives the edit.

use rusqlite::{Connection, params};
use serde_json::Value;

use crate::api::errors::StorageError;
use crate::domain::notes::{failed, next_clock, require_payload};
use crate::domain::task_merge::{self, Gate};
use crate::domain::tasks::Inbound;
use crate::storage::repositories::schema::Object;
use crate::storage::repositories::sync_items::{self, InboundRecord};
use crate::storage::repositories::{Change, StoredPayload};

/// The keys a local record keeps over a remote that wins its clock.
pub(crate) struct Kept {
    /// `data.x ?? existing.x`: an absent or `null` remote value keeps the
    /// local one.
    pub coalesce: &'static [&'static str],
    /// `data.x !== undefined ? data.x : existing.x`: only an absent key keeps
    /// the local value, and `null` clears it.
    pub when_absent: &'static [&'static str],
    /// Never taken from a remote over a local record.
    pub local: &'static [&'static str],
}

/// The stored payload of `(item_type, item_id)`, when the row has one that
/// parses. `live_only` passes over a tombstoned row.
pub(crate) fn stored(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
    live_only: bool,
) -> Result<Option<StoredPayload>, StorageError> {
    Ok(sync_items::load(conn, item_type, item_id)?
        .filter(|row| !live_only || row.deleted_at.is_none())
        .and_then(|row| StoredPayload::parse(&row.payload?).ok()))
}

/// Applies `remote` over `local` by `kept`, after §6.3.1's gate. `extra` are
/// edits the type's own rule adds to the remote payload.
pub(crate) fn apply_kept(
    conn: &Connection,
    record: &InboundRecord,
    remote: &StoredPayload,
    local: Option<&StoredPayload>,
    kept: &Kept,
    extra: Vec<(&'static str, Change)>,
    now_ms: i64,
) -> Result<Inbound, StorageError> {
    let merged_clock = match task_merge::document_gate(conn, record)? {
        Gate::Skip => return Ok(Inbound::Skipped),
        Gate::Wholesale => None,
        Gate::Merge { merged_clock, .. } => Some(merged_clock),
    };
    let mut changes = match local {
        Some(local) => kept_changes(local.object(), remote.object(), kept),
        None => Vec::new(),
    };
    changes.extend(extra);
    if let Some(clock) = merged_clock {
        let clock = serde_json::to_value(clock).map_err(|error| StorageError::Failed {
            what: format!("clock will not serialise: {error}"),
        })?;
        changes.push(("clock", Change::Set(clock)));
    }
    let merged = InboundRecord {
        payload_json: remote.merge(&changes),
        ..record.clone()
    };
    task_merge::wholesale(conn, &merged, now_ms)
}

fn kept_changes(local: &Object, remote: &Object, kept: &Kept) -> Vec<(&'static str, Change)> {
    let keeps = |key: &str| {
        if kept.coalesce.contains(&key) {
            remote.get(key).is_none_or(Value::is_null)
        } else if kept.when_absent.contains(&key) {
            !remote.contains_key(key)
        } else {
            kept.local.contains(&key)
        }
    };
    kept.coalesce
        .iter()
        .chain(kept.when_absent)
        .chain(kept.local)
        .copied()
        .filter(|key| keeps(key))
        .filter_map(|key| {
            let value = local.get(key)?;
            (remote.get(key) != Some(value)).then(|| (key, Change::Set(value.clone())))
        })
        .collect()
}

/// The stored payload of a live record, or `NotFound` naming `what`.
pub(crate) fn live(
    tx: &Connection,
    item_type: &str,
    item_id: &str,
    what: &str,
) -> Result<StoredPayload, StorageError> {
    let row = sync_items::load(tx, item_type, item_id)?;
    if row.as_ref().is_none_or(|row| row.deleted_at.is_some()) {
        return Err(StorageError::NotFound {
            what: format!("no {what} {item_id}"),
        });
    }
    require_payload(tx, item_type, item_id)
}

/// Merges `changes` into the stored payload under this device's next tick.
pub(crate) fn edit(
    tx: &Connection,
    item_type: &str,
    item_id: &str,
    stored: &StoredPayload,
    mut changes: Vec<(&'static str, Change)>,
    device_id: &str,
    now_ms: i64,
) -> Result<String, StorageError> {
    changes.push((
        "clock",
        Change::Set(next_clock(stored.object(), device_id)?),
    ));
    sync_items::apply_local_edit_in(tx, item_type, item_id, &changes, now_ms)
}

/// Marks the record deleted and ticks its clock, so a later re-create of the
/// id carries a clock past the delete.
pub(crate) fn tombstone(
    tx: &Connection,
    item_type: &str,
    item_id: &str,
    stored: &StoredPayload,
    changes: Vec<(&'static str, Change)>,
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    tx.execute(
        "UPDATE sync_items SET deleted_at = ?3, updated_at = ?3
         WHERE item_type = ?1 AND item_id = ?2",
        params![item_type, item_id, now_ms],
    )
    .map_err(failed)?;
    edit(tx, item_type, item_id, stored, changes, device_id, now_ms).map(drop)
}

#[cfg(test)]
pub(crate) mod testing;
#[cfg(test)]
mod tests;
