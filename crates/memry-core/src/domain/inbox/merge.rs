//! Applying a remote `inbox` record: desktop's `InboxHandler.applyUpsert`
//! (`apps/desktop/src/main/sync/item-handlers/inbox-handler.ts`), rule for
//! rule.
//!
//! 1. **Document-level gate** on `clock` (chapter 06 §6.3.1, the same gate
//!    every non-field-merged type runs): a local clock that dominates skips
//!    the remote; concurrent clocks apply the remote under the union clock
//!    (desktop's "last write wins").
//! 2. **Key-by-key overlay** onto the local payload when one exists. A key the
//!    remote **omits** keeps the local value — the sender predates the column
//!    and must not clobber it. A key the remote sends as **`null`** is the
//!    explicit clear that unsnooze, unarchive and unfile push, and it clears.
//!    `title` and `type` are the two exceptions: desktop reads them as
//!    `data.x ?? existing.x`, so a `null` keeps them too.
//! 3. With nothing local, the remote applies as it arrived; the projector
//!    supplies desktop's insert defaults (`Untitled`, `note`).
//!
//! Keys this build does not model ride along either way (§13.2 rule 3): the
//! overlay starts from the local object and inserts every remote key. Nothing
//! here enqueues (§6.5.2 P3).

use rusqlite::Connection;
use serde_json::Value;

use crate::api::errors::StorageError;
use crate::domain::task_merge::{self, Gate};
use crate::domain::tasks::Inbound;
use crate::storage::repositories::StoredPayload;
use crate::storage::repositories::sync_items::{self, InboundRecord};
use crate::sync::clock::VectorClock;

/// The two keys a `null` never clears (`data.title ?? existing.title`).
const NEVER_CLEARED: [&str; 2] = ["title", "type"];

/// §6.8's `inbox` row: the document gate, then desktop's overlay.
pub(crate) fn apply_remote(
    conn: &Connection,
    record: &InboundRecord,
    now_ms: i64,
) -> Result<Inbound, StorageError> {
    match task_merge::document_gate(conn, record)? {
        Gate::Skip => Ok(Inbound::Skipped),
        Gate::Wholesale => {
            let Some(local) = live_local(conn, record)? else {
                return task_merge::wholesale(conn, record, now_ms);
            };
            let Ok(remote) = StoredPayload::parse(&record.payload_json) else {
                // Not this path's to diagnose: the wholesale store records it.
                return task_merge::wholesale(conn, record, now_ms);
            };
            let merged = InboundRecord {
                payload_json: overlay(&local, &remote, None)?,
                ..record.clone()
            };
            task_merge::wholesale(conn, &merged, now_ms)
        }
        Gate::Merge {
            local,
            remote,
            merged_clock,
        } => {
            let merged = InboundRecord {
                payload_json: overlay(&local, &remote, Some(&merged_clock))?,
                ..record.clone()
            };
            task_merge::wholesale(conn, &merged, now_ms)
        }
    }
}

/// The local payload with every remote key laid over it, as one JSON string.
///
/// `clock` overrides the remote's own clock on the concurrent branch, where
/// the stored clock must be the union (§6.3.1, `mergedClock`).
pub fn overlay(
    local: &StoredPayload,
    remote: &StoredPayload,
    clock: Option<&VectorClock>,
) -> Result<String, StorageError> {
    let mut merged = local.object().clone();
    for (key, value) in remote.object() {
        if value.is_null() && NEVER_CLEARED.contains(&key.as_str()) {
            continue;
        }
        merged.insert(key.clone(), value.clone());
    }
    if let Some(clock) = clock {
        let clock = serde_json::to_value(clock).map_err(|error| StorageError::Failed {
            what: format!("clock will not serialise: {error}"),
        })?;
        merged.insert("clock".to_owned(), clock);
    }
    serde_json::to_string(&Value::Object(merged)).map_err(|error| StorageError::Failed {
        what: format!("merged inbox payload will not serialise: {error}"),
    })
}

/// The stored payload of a live local row, if any. A deleted or metadata-only
/// row has nothing to overlay onto.
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

#[cfg(test)]
mod tests {
    use super::*;

    fn payload(json: &str) -> StoredPayload {
        StoredPayload::parse(json).expect("test payload is JSON")
    }

    fn merged(local: &str, remote: &str) -> Value {
        let text = overlay(&payload(local), &payload(remote), None).expect("overlay");
        serde_json::from_str(&text).expect("overlay is JSON")
    }

    #[test]
    fn an_absent_key_keeps_the_local_value() {
        let out = merged(
            r#"{"title":"a","snoozedUntil":"2026-10-01T09:00:00.000Z","transcription":"hi"}"#,
            r#"{"title":"b"}"#,
        );
        assert_eq!(out["title"], "b");
        assert_eq!(out["snoozedUntil"], "2026-10-01T09:00:00.000Z");
        assert_eq!(out["transcription"], "hi");
    }

    #[test]
    fn an_explicit_null_clears_except_title_and_type() {
        let out = merged(
            r#"{"title":"a","type":"link","archivedAt":"2026-10-01T09:00:00.000Z","filedTo":"x"}"#,
            r#"{"title":null,"type":null,"archivedAt":null,"filedTo":null}"#,
        );
        assert_eq!(out["title"], "a");
        assert_eq!(out["type"], "link");
        assert_eq!(out["archivedAt"], Value::Null);
        assert_eq!(out["filedTo"], Value::Null);
    }

    #[test]
    fn the_concurrent_branch_stores_the_union_clock() {
        let mut clock = VectorClock::new();
        clock.insert("a".to_owned(), 2);
        clock.insert("b".to_owned(), 3);
        let text = overlay(
            &payload(r#"{"clock":{"a":2}}"#),
            &payload(r#"{"clock":{"b":3}}"#),
            Some(&clock),
        )
        .expect("overlay");
        let out: Value = serde_json::from_str(&text).expect("json");
        assert_eq!(out["clock"]["a"], 2);
        assert_eq!(out["clock"]["b"], 3);
    }
}
