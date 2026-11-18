//! A remote `note` record: §6.3.1's document gate, then chapter 06 §6.8.1's
//! union of `attachmentReferences`, as Electron's note handler runs it
//! (`apps/desktop/src/main/sync/item-handlers/note-handler.ts:135-145`,
//! `:537-553`).
//!
//! The union runs on every apply over a live local note: the concurrent
//! branch, whose merged row is re-queued with the union in it (§6.5.2 P3), and
//! the branch where the remote dominates. Electron unions after both. A new
//! note, a tombstone and a skip take the gate's answer unchanged.

use std::collections::HashSet;

use rusqlite::Connection;
use serde_json::Value;

use crate::api::errors::StorageError;
use crate::domain::task_merge::{self, Gate};
use crate::domain::tasks::Inbound;
use crate::storage::repositories::schema::Object;
use crate::storage::repositories::sync_items::{self, InboundRecord};
use crate::storage::repositories::{Change, StoredPayload};
use crate::sync::attachments::store::download_failures;
use crate::sync::hardening::requeue;

const REFERENCES: &str = "attachmentReferences";

pub(crate) fn apply_remote(
    conn: &Connection,
    record: &InboundRecord,
    now_ms: i64,
) -> Result<Inbound, StorageError> {
    match task_merge::document_gate(conn, record)? {
        Gate::Skip => Ok(Inbound::Skipped),
        Gate::Wholesale => {
            let (Some(local), Ok(remote)) = (
                live_local(conn, record)?,
                StoredPayload::parse(&record.payload_json),
            ) else {
                return task_merge::wholesale(conn, record, now_ms);
            };
            let Some(union) = union(conn, record, local.object(), remote.object()) else {
                return task_merge::wholesale(conn, record, now_ms);
            };
            let merged = InboundRecord {
                payload_json: remote.merge(&[(REFERENCES, Change::set(union))]),
                ..record.clone()
            };
            task_merge::wholesale(conn, &merged, now_ms)
        }
        Gate::Merge {
            local,
            remote,
            merged_clock,
        } => {
            // `task_merge::with_clock`'s write, with the union beside it.
            let clock =
                serde_json::to_value(&merged_clock).map_err(|error| StorageError::Failed {
                    what: error.to_string(),
                })?;
            let mut changes = vec![("clock", Change::Set(clock))];
            if let Some(union) = union(conn, record, local.object(), remote.object()) {
                changes.push((REFERENCES, Change::set(union)));
            }
            let merged = InboundRecord {
                payload_json: remote.merge(&changes),
                ..record.clone()
            };
            requeue::store_merged(conn, &merged, now_ms)
        }
    }
}

/// The stored payload of a live local note: the `existing` row Electron
/// unions against. A deleted row or one that will not parse has none.
fn live_local(
    conn: &Connection,
    record: &InboundRecord,
) -> Result<Option<StoredPayload>, StorageError> {
    let Some(row) = sync_items::load(conn, &record.item_type, &record.item_id)? else {
        return Ok(None);
    };
    if row.deleted_at.is_some() {
        return Ok(None);
    }
    Ok(row.payload.and_then(|raw| StoredPayload::parse(&raw).ok()))
}

/// The list to store, or `None` to store the remote's value as it came. A
/// tombstone record keeps its own payload: no union is written into it.
///
/// `mergeAttachmentReferences`: a remote list that is absent, `null` or empty
/// keeps the local list. Otherwise the local entries in their order (local
/// duplicates kept), then each remote id the result does not hold yet, in
/// the remote's order. `pruneUnresolvableReferences` then drops the ids the
/// server proved gone; a prune that fails is logged and keeps every id, as
/// its try/catch does. A remote value that is not an array of strings is left
/// for the projector to refuse, as `NoteSyncPayloadSchema` refuses it.
fn union(
    conn: &Connection,
    record: &InboundRecord,
    local: &Object,
    remote: &Object,
) -> Option<Vec<String>> {
    if record.deleted_at.is_some() {
        return None;
    }
    let remote = match remote.get(REFERENCES) {
        None | Some(Value::Null) => Vec::new(),
        Some(value) => strings(value)?,
    };
    let local = local.get(REFERENCES).and_then(strings);
    if remote.is_empty() {
        return local;
    }
    let mut merged = local.unwrap_or_default();
    let mut seen: HashSet<String> = merged.iter().cloned().collect();
    for id in remote {
        if seen.insert(id.clone()) {
            merged.push(id);
        }
    }
    match download_failures::proven_gone(conn, &record.item_id, &merged) {
        Ok(gone) => merged.retain(|id| !gone.contains(id)),
        Err(error) => eprintln!(
            "memry-core: could not prune attachment references of note {}: {error}",
            record.item_id
        ),
    }
    Some(merged)
}

fn strings(value: &Value) -> Option<Vec<String>> {
    value
        .as_array()?
        .iter()
        .map(|entry| entry.as_str().map(str::to_owned))
        .collect()
}
