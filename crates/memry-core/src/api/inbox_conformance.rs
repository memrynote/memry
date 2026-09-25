//! The conformance seam for the `inbox` class (spec 006 IB014).
//!
//! `inbox.json` pins desktop's apply rule and its list and stats reads over
//! fixed rows at a fixed `now`. No FFI write can mint those rows (fixed
//! `createdAt`s, a peer's clocks), so, as [`crate::api::task_conformance`]
//! does, this takes the vector's own JSON and runs it through the **same**
//! production path a pull uses — [`crate::sync::apply::apply_inbound`] into a
//! throwaway in-memory database — then the same reads `Inbox` answers,
//! returning JSON in the file's shape.

use serde_json::{Map, Value, json};

use crate::api::errors::StorageError;
use crate::domain::inbox::{self, InboxItem, stats};
use crate::storage::Db;
use crate::storage::migrations;
use crate::storage::repositories::instants;
use crate::storage::repositories::sync_items::InboundRecord;
use crate::sync::apply::apply_inbound;

fn fresh() -> Result<Db, StorageError> {
    let db = Db::open_in_memory()?;
    db.call_blocking(|conn| migrations::run(conn, migrations::DATA_MIGRATIONS))?;
    Ok(db)
}

fn record(id: &str, payload: &Value, deleted_at: Option<i64>) -> InboundRecord {
    InboundRecord {
        item_type: inbox::ITEM_TYPE.to_owned(),
        item_id: id.to_owned(),
        payload_json: payload.to_string(),
        server_cursor: None,
        signer_device_id: None,
        updated_at: 0,
        deleted_at,
    }
}

fn iso(ms: Option<i64>) -> Value {
    ms.and_then(instants::to_iso8601)
        .map_or(Value::Null, Value::String)
}

fn text(value: Option<String>) -> Value {
    value.map_or(Value::Null, Value::String)
}

/// A projected capture in the vector's `expected` shape.
fn row(item: InboxItem) -> Value {
    json!({
        "type": item.item_type,
        "title": item.title,
        "content": text(item.content),
        "metadata": item.metadata.unwrap_or(Value::Null),
        "filedAt": iso(item.filed_at),
        "filedTo": text(item.filed_to),
        "filedAction": text(item.filed_action),
        "snoozedUntil": iso(item.snoozed_until),
        "snoozeReason": text(item.snooze_reason),
        "archivedAt": iso(item.archived_at),
        "sourceUrl": text(item.source_url),
        "sourceTitle": text(item.source_title),
        "captureSource": text(item.capture_source),
        "createdAt": if item.created_at == 0 { Value::Null } else { iso(Some(item.created_at)) },
    })
}

fn apply_case(case: &Value) -> Result<Value, StorageError> {
    let db = fresh()?;
    let steps = case["steps"].as_array().cloned().unwrap_or_default();
    db.call_blocking(move |conn| {
        for (index, step) in steps.iter().enumerate() {
            let at = (index as i64 + 1) * 1_000;
            let deleted = step["deleted"].as_bool() == Some(true);
            apply_inbound(
                conn,
                &record("inbox-1", &step["payload"], deleted.then_some(at)),
                at,
            )?;
        }
        Ok(inbox::get(conn, "inbox-1")?.map_or(Value::Null, row))
    })
}

fn views(section: &Value) -> Result<Value, StorageError> {
    let now = section["now"]
        .as_str()
        .and_then(instants::to_epoch_ms)
        .unwrap_or_default();
    let stale_days = section["staleDays"]
        .as_i64()
        .unwrap_or(stats::DEFAULT_STALE_DAYS);
    let rows = section["rows"].as_array().cloned().unwrap_or_default();
    let db = fresh()?;
    db.call_blocking(move |conn| {
        for entry in &rows {
            let id = entry["id"].as_str().unwrap_or_default();
            apply_inbound(conn, &record(id, &entry["payload"], None), now)?;
        }
        let ids = |items: Vec<InboxItem>| items.into_iter().map(|i| i.id).collect::<Vec<_>>();
        let mut counts = Map::new();
        for (kind, count) in inbox::type_counts(conn)? {
            counts.insert(kind, json!(count));
        }
        let s = stats::stats(conn, now, stale_days)?;
        Ok(json!({
            "listIds": ids(inbox::list_active(conn, false)?),
            "snoozedIds": ids(inbox::snoozed(conn)?),
            "typeCounts": counts,
            "reviewable": inbox::reviewable_count(conn)?,
            "fetching": inbox::fetching_count(conn)?,
            "stats": {
                "totalItems": s.total_items,
                "staleCount": s.stale_count,
                "snoozedCount": s.snoozed_count,
                "capturedToday": s.captured_today,
                "processedToday": s.processed_today,
                "capturedThisWeek": s.captured_this_week,
                "processedThisWeek": s.processed_this_week,
                "avgTimeToProcess": s.avg_time_to_process,
                "currentStreak": s.current_streak,
                "processRate": s.process_rate,
            },
        }))
    })
}

/// `inbox.json` evaluated by the core: `{apply: [{name, actual}], views}`,
/// each `actual` in the shape of the file's `expected`. A failure is reported
/// in the JSON (`error`), never a panic.
#[uniffi::export]
pub fn inbox_conformance(vector_json: String) -> String {
    let vector: Value = serde_json::from_str(&vector_json).unwrap_or(Value::Null);
    let apply: Vec<Value> = vector["apply"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .map(|case| match apply_case(case) {
            Ok(actual) => json!({ "name": case["name"], "actual": actual }),
            Err(error) => json!({ "name": case["name"], "error": error.to_string() }),
        })
        .collect();
    let views =
        views(&vector["views"]).unwrap_or_else(|error| json!({ "error": error.to_string() }));
    json!({ "apply": apply, "views": views }).to_string()
}
