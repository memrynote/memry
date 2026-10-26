//! A task's tag field values (`task.fields`, §13.7.3.1): a local edit is
//! stamped by chapter 06 §6.11.3, and every inbound apply joins the map by
//! §6.11.2 and heals by §6.11.4.
//!
//! Real SQLite, records applied through the pull's entry point.

use memry_core::domain::tasks;
use memry_core::storage::repositories::sync_items::{self, ApplyOutcome, InboundRecord};
use memry_core::storage::{Db, open_data};
use memry_core::sync::apply::apply_inbound_on;
use memry_core::sync::outbox;
use rusqlite::Connection;
use serde_json::{Value, json};

const NOW: i64 = 1_760_000_000_000;
const ME: &str = "device-a";

fn open() -> Db {
    let dir = tempfile::Builder::new()
        .prefix("memry-task-fields-")
        .tempdir()
        .expect("the scratch directory")
        .keep();
    std::fs::create_dir_all(&dir).expect("the scratch directory");
    open_data(&dir.join("data.db")).expect("open data.db")
}

fn apply(conn: &Connection, item_type: &str, payload: Value) -> ApplyOutcome {
    let record = InboundRecord {
        item_type: item_type.to_owned(),
        item_id: if item_type == "task" { "t1" } else { "pa" }.to_owned(),
        payload_json: payload.to_string(),
        server_cursor: None,
        signer_device_id: None,
        updated_at: NOW,
        deleted_at: None,
    };
    apply_inbound_on(conn, &record, NOW, Some(ME)).expect("apply")
}

fn payload(conn: &Connection) -> Value {
    let raw = sync_items::push_payload(conn, "task", "t1")
        .expect("read")
        .expect("a payload");
    serde_json::from_str(&raw).expect("JSON")
}

fn seed(conn: &Connection, fields: Option<Value>, clock: Value) {
    apply(
        conn,
        "project",
        json!({"name": "pa", "color": "#0ea5e9", "clock": {"device-b": 1},
               "statuses": [{"id": "s", "name": "To Do", "color": "#6b7280", "position": 0, "isDefault": true}]}),
    );
    let mut task = json!({"title": "Ask", "projectId": "pa", "clock": clock});
    if let Some(fields) = fields {
        task["fields"] = fields;
    }
    assert_eq!(apply(conn, "task", task), ApplyOutcome::Applied);
}

fn queued(conn: &Connection) -> usize {
    outbox::depth(conn).expect("the outbox")
}

#[test]
fn a_local_edit_stamps_above_the_clock_total_and_queues_the_task() {
    open()
        .call_blocking(|conn| {
            seed(
                conn,
                Some(json!({"Owner": {"v": "Deniz", "t": 2, "x": 1}})),
                json!({"device-b": 4}),
            );
            let before = queued(conn);

            let wrote = tasks::set_field_value(conn, "t1", "Due", json!("2026-05-14"), ME, NOW)?;
            assert_eq!(wrote, Some((Value::Null, json!("2026-05-14"))));
            // t = max(clockTotal 4, highest t 2) + 1; the untouched entry keeps
            // the key a newer build added.
            assert_eq!(
                payload(conn)["fields"],
                json!({"Owner": {"v": "Deniz", "t": 2, "x": 1}, "Due": {"v": "2026-05-14", "t": 5}})
            );
            assert_eq!(
                payload(conn)["clock"],
                json!({"device-b": 4, "device-a": 1})
            );
            assert_eq!(queued(conn), before + 1);

            assert_eq!(
                tasks::set_field_value(conn, "t1", "Due", json!("2026-05-14"), ME, NOW)?,
                None
            );
            // An empty list is unfilled, so it removes the value.
            tasks::set_field_value(conn, "t1", "Owner", json!([]), ME, NOW)?;
            assert_eq!(
                payload(conn)["fields"]["Owner"],
                json!({"v": null, "t": 6, "x": 1})
            );
            Ok(())
        })
        .expect("the edit");
}

#[test]
fn a_newer_remote_whose_map_is_stale_keeps_the_local_entry_and_heals() {
    open()
        .call_blocking(|conn| {
            seed(
                conn,
                Some(json!({"Owner": {"v": "Deniz", "t": 3}})),
                json!({"device-b": 1}),
            );
            let before = queued(conn);

            // A pre-§6.11 desktop echoes an older capture under a newer clock.
            apply(
                conn,
                "task",
                json!({"title": "Ask", "projectId": "pa", "clock": {"device-b": 2},
                       "fields": {"Owner": {"v": "Old", "t": 1}, "Due": {"v": "x", "t": 1}}}),
            );
            let stored = payload(conn);
            assert_eq!(
                stored["fields"],
                json!({"Owner": {"v": "Deniz", "t": 3}, "Due": {"v": "x", "t": 1}})
            );
            assert_eq!(
                stored["clock"],
                json!({"device-b": 2, "device-a": 1}),
                "the heal ticks this device"
            );
            assert_eq!(queued(conn), before + 1, "and re-pushes");
            Ok(())
        })
        .expect("the heal");
}

#[test]
fn a_remote_without_the_key_keeps_the_local_map() {
    open()
        .call_blocking(|conn| {
            seed(
                conn,
                Some(json!({"Owner": {"v": "Deniz", "t": 3}})),
                json!({"device-b": 1}),
            );
            apply(
                conn,
                "task",
                json!({"title": "Ask", "projectId": "pa", "clock": {"device-b": 2}}),
            );
            assert_eq!(
                payload(conn)["fields"],
                json!({"Owner": {"v": "Deniz", "t": 3}})
            );
            Ok(())
        })
        .expect("the absent key");
}

#[test]
fn a_skip_still_joins_newer_entries_and_never_heals() {
    open()
        .call_blocking(|conn| {
            seed(
                conn,
                Some(json!({"Owner": {"v": "Deniz", "t": 3}})),
                json!({"device-b": 2}),
            );
            let before = queued(conn);
            let outcome = apply(
                conn,
                "task",
                json!({"title": "Ask", "projectId": "pa", "clock": {"device-b": 1},
                       "fields": {"Owner": {"v": "Ada", "t": 4}}}),
            );
            assert_eq!(outcome, ApplyOutcome::Skipped);
            assert_eq!(
                payload(conn)["fields"],
                json!({"Owner": {"v": "Ada", "t": 4}})
            );
            assert_eq!(payload(conn)["clock"], json!({"device-b": 2}));
            assert_eq!(queued(conn), before);
            Ok(())
        })
        .expect("the skip");
}

#[test]
fn an_insert_and_a_remote_null_never_heal() {
    open()
        .call_blocking(|conn| {
            seed(conn, Some(json!({"Owner": {"v": "Deniz", "t": 3}})), json!({"device-b": 1}));
            let before = queued(conn);
            assert_eq!(before, 0, "an insert queues nothing");
            apply(
                conn,
                "task",
                json!({"title": "Ask", "projectId": "pa", "clock": {"device-b": 2}, "fields": null}),
            );
            assert_eq!(payload(conn)["fields"], json!({"Owner": {"v": "Deniz", "t": 3}}));
            assert_eq!(queued(conn), before);
            Ok(())
        })
        .expect("no heal");
}
