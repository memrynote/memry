//! What `canvas_folder`, `home_page` and `sticky_draft` share (Step 16,
//! #3533): one whole-record clock, a desktop handler that keeps some local
//! keys over a newer remote, and local writes that tick that clock.
//!
//! Inbound, [`apply_kept`] first skips a remote that fails desktop's schema (a
//! schema key of the wrong type, a clock tick that is not a safe non-negative
//! integer, or a `null` in [`Kept::not_null`]), and [`unreadable`] a live
//! remote that is not an object over a local row; then [`apply_kept`] is
//! §6.3.1's document gate followed by the remote
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
use crate::domain::notes::{clock_in, failed, next_clock, require_payload};
use crate::domain::task_merge::{self, Gate};
use crate::domain::tasks::Inbound;
use crate::storage::repositories::projectors;
use crate::storage::repositories::schema::Object;
use crate::storage::repositories::sync_items::{self, InboundRecord};
use crate::storage::repositories::{Change, StoredPayload};

/// The keys a local record keeps over a remote that wins its clock, and the
/// schema keys a remote may not state as `null`.
pub(crate) struct Kept {
    /// The schema keys desktop's schema refuses `null` for
    /// (`packages/contracts/src/sync-payloads.ts`, every one `.optional()`
    /// without `.nullable()`). [`apply_kept`] skips a remote that nulls one.
    pub not_null: &'static [&'static str],
    /// `data.x ?? existing.x`: an absent remote value keeps the local one.
    /// Every one is in `not_null`.
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

/// JavaScript's `Number.MAX_SAFE_INTEGER`, the largest tick `z.int()` takes.
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

/// A live record whose payload is not a JSON object. Desktop refuses it
/// (`parse_error` or `schema_invalid`,
/// `apps/desktop/src/main/sync/apply-item.ts:155-176`),
/// so a local row stays as it is; with none, it is stored as corrupt. A delete
/// is the tombstone path unchanged.
pub(crate) fn unreadable(
    conn: &Connection,
    record: &InboundRecord,
    now_ms: i64,
) -> Result<Inbound, StorageError> {
    if record.deleted_at.is_none()
        && sync_items::load(conn, &record.item_type, &record.item_id)?.is_some()
    {
        return Ok(Inbound::Skipped);
    }
    task_merge::wholesale(conn, record, now_ms)
}

/// Applies `remote` over `local` by `kept`, after desktop's schema and
/// §6.3.1's gate. `extra` are edits the type's own rule adds to the remote
/// payload.
pub(crate) fn apply_kept(
    conn: &Connection,
    record: &InboundRecord,
    remote: &StoredPayload,
    local: Option<&StoredPayload>,
    kept: &Kept,
    extra: Vec<(&'static str, Change)>,
    now_ms: i64,
) -> Result<Inbound, StorageError> {
    // Desktop parses the remote with the type's schema before its handler
    // reads the local row, and refuses the whole record on a schema key of the
    // wrong type or a `null` the schema has no room for (`schema_invalid`,
    // `apps/desktop/src/main/sync/apply-item.ts:166-176`). Skipped here before
    // the gate, so the local record stays as it is.
    debug_assert!(
        kept.coalesce.iter().all(|key| kept.not_null.contains(key)),
        "every coalesce key is in not_null"
    );
    let remote_object = remote.object();
    // `VectorClockSchema`'s ticks are safe non-negative integers
    // (`packages/contracts/src/sync-api.ts:386`); `Kind::Clock` takes any number.
    let clock_ok = clock_in(remote_object)
        .is_ok_and(|clock| clock.values().all(|tick| *tick <= MAX_SAFE_INTEGER));
    let refused = !clock_ok
        || projectors::read(&record.item_type, remote_object).is_err()
        || kept
            .not_null
            .iter()
            .any(|key| remote_object.get(*key).is_some_and(Value::is_null));
    if refused {
        return Ok(Inbound::Skipped);
    }
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
    // A `null` coalesce key never reaches here (see `Kept::not_null`).
    let keeps = |key: &str| kept.local.contains(&key) || !remote.contains_key(key);
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
