use rusqlite::Connection;
use serde_json::{Value, json};

use crate::storage::repositories::sync_items::{self, InboundRecord};
use crate::storage::{open_data, test_support::temp_dir};
use crate::sync::apply::apply_inbound_on;
use crate::sync::clock::{VectorClock, clock_of};

/// One payload per merge site the requeue covers, under `clock`.
fn payload(item_type: &str, clock: &VectorClock) -> String {
    let body = match item_type {
        "task" => json!({"title": "Ship", "projectId": "proj-1", "priority": 1}),
        "project" => json!({"name": "Alpha", "color": "#0ea5e9", "position": 0}),
        "calendar_event" => json!({
            "title": "Standup", "startAt": "2026-05-01T09:00:00.000Z",
            "endAt": "2026-05-01T09:15:00.000Z", "isAllDay": false, "timezone": "UTC",
        }),
        "calendar_source" => json!({
            "provider": "google", "kind": "calendar", "accountId": "acct-1",
            "remoteId": "primary", "title": "Work", "timezone": "UTC",
        }),
        "inbox" => json!({"type": "text", "title": "Read later", "content": "x"}),
        other => panic!("no fixture for {other}"),
    };
    let mut body = body;
    body["clock"] = json!(clock);
    body.to_string()
}

fn record(item_type: &str, clock: &VectorClock) -> InboundRecord {
    InboundRecord {
        item_type: item_type.to_owned(),
        item_id: format!("{item_type}-1"),
        payload_json: payload(item_type, clock),
        server_cursor: Some(1),
        signer_device_id: Some("peer".to_owned()),
        updated_at: 1,
        deleted_at: None,
    }
}

fn queued(conn: &Connection, item_type: &str) -> Vec<(String, Option<Vec<u8>>)> {
    let mut statement = conn
        .prepare("SELECT op, payload FROM outbox WHERE item_type = ?1 AND item_id = ?2")
        .expect("prepare");
    statement
        .query_map([item_type, &format!("{item_type}-1")], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .expect("query")
        .map(|row| row.expect("row"))
        .collect()
}

fn stored_clock(conn: &Connection, item_type: &str) -> Value {
    let raw = sync_items::push_payload(conn, item_type, &format!("{item_type}-1"))
        .expect("read")
        .expect("a payload");
    serde_json::from_str::<Value>(&raw).expect("json")["clock"].clone()
}

const MERGE_SITES: [&str; 5] = [
    "task",
    "project",
    "calendar_event",
    "calendar_source",
    "inbox",
];

#[test]
fn a_concurrent_merge_queues_one_update_carrying_the_union_clock() {
    let dir = temp_dir("requeue-concurrent");
    let db = open_data(&dir.path().join("data.db")).expect("open data.db");
    db.call_blocking(|conn| {
        for item_type in MERGE_SITES {
            let local = record(item_type, &clock_of([("a", 2)]));
            apply_inbound_on(conn, &local, 1, Some("a"))?;
            assert!(queued(conn, item_type).is_empty(), "{item_type}: seeded");

            let remote = record(item_type, &clock_of([("a", 1), ("b", 1)]));
            apply_inbound_on(conn, &remote, 2, Some("a"))?;

            assert_eq!(
                queued(conn, item_type),
                vec![("upsert".to_owned(), None)],
                "{item_type}: one update, its payload rebuilt at push (§6.5.2 P2)"
            );
            assert_eq!(
                stored_clock(conn, item_type),
                json!({"a": 2, "b": 1}),
                "{item_type}: the union, not ticked again"
            );
        }
        Ok(())
    })
    .expect("merge");
}

#[test]
fn an_apply_that_is_not_concurrent_queues_nothing() {
    let dir = temp_dir("requeue-ordered");
    let db = open_data(&dir.path().join("data.db")).expect("open data.db");
    db.call_blocking(|conn| {
        for item_type in MERGE_SITES {
            apply_inbound_on(
                conn,
                &record(item_type, &clock_of([("a", 1)])),
                1,
                Some("a"),
            )?;
            // `before`: the remote dominates and applies wholesale.
            apply_inbound_on(
                conn,
                &record(item_type, &clock_of([("a", 2)])),
                2,
                Some("a"),
            )?;
            // `equal` over an identical payload: skipped (§6.5.2 P4).
            apply_inbound_on(
                conn,
                &record(item_type, &clock_of([("a", 2)])),
                3,
                Some("a"),
            )?;
            // `after`: the local dominates and the remote is skipped.
            apply_inbound_on(
                conn,
                &record(item_type, &clock_of([("a", 1)])),
                4,
                Some("a"),
            )?;
            assert!(queued(conn, item_type).is_empty(), "{item_type}");
        }
        Ok(())
    })
    .expect("ordered applies");
}
