use std::sync::atomic::{AtomicU64, Ordering};

use memry_core::domain::calendar::LocalDateTime;
use memry_core::domain::tasks;
use memry_core::storage::repositories::sync_items::{self, ApplyOutcome, InboundRecord};
use memry_core::storage::{Db, open_data};
use memry_core::sync::apply::apply_inbound;
use rusqlite::Connection;
use serde_json::{Value, json};

const NOW: i64 = 1_760_000_000_000;
const DEVICE: &str = "device-a";

static SCRATCH: AtomicU64 = AtomicU64::new(0);

fn open(label: &str) -> Db {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "memry-carry-{label}-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("the scratch directory");
    open_data(&dir.join("data.db")).expect("open data.db")
}

fn apply(conn: &Connection, item_type: &str, item_id: &str, payload: Value) {
    let record = InboundRecord {
        item_type: item_type.to_owned(),
        item_id: item_id.to_owned(),
        payload_json: serde_json::to_string(&payload).expect("serialise"),
        server_cursor: None,
        signer_device_id: None,
        updated_at: NOW,
        deleted_at: None,
    };
    let outcome = apply_inbound(conn, &record, NOW).expect("apply");
    assert_eq!(outcome, ApplyOutcome::Applied, "{item_type} {item_id}");
}

fn payload_of(conn: &Connection, item_type: &str, item_id: &str) -> Value {
    let raw = sync_items::push_payload(conn, item_type, item_id)
        .expect("read the row")
        .expect("a payload");
    serde_json::from_str(&raw).expect("valid JSON")
}

fn fields() -> Value {
    json!({
        "Waiting on": {"v": ["memry://note/abc123def456"], "t": 2},
        "Thread": {"v": null, "t": 3, "addedByNewerBuild": {"source": "agent"}}
    })
}

fn schema() -> Value {
    json!({
        "t": 3,
        "fields": [{"name": "Company", "relation": {"target": "company", "many": false}},
                   {"name": "Phone", "format": "e164"}],
        "template": null,
        "extends": null,
        "preset": "person"
    })
}

fn seed_project(conn: &Connection) {
    apply(
        conn,
        "project",
        "pa",
        json!({
            "name": "pa",
            "color": "#0ea5e9",
            "statuses": [
                {"id": "pa-todo", "name": "To Do", "color": "#6b7280", "position": 0, "isDefault": true},
                {"id": "pa-done", "name": "Done", "color": "#22c55e", "position": 1, "isDone": true}
            ],
            "clock": {"device-b": 1}
        }),
    );
}

#[test]
fn a_wholesale_apply_stores_both_keys_as_sent() {
    let db = open("wholesale");
    db.call_blocking(|conn| {
        seed_project(conn);
        apply(conn, "task", "t1", json!({"title": "Ask", "projectId": "pa", "clock": {"device-b": 1}}));
        apply(
            conn,
            "task",
            "t1",
            json!({"title": "Ask", "projectId": "pa", "fields": fields(), "clock": {"device-b": 2}}),
        );
        apply(conn, "tag_definition", "person", json!({"name": "person", "color": "#111", "clock": {"device-b": 1}}));
        apply(
            conn,
            "tag_definition",
            "person",
            json!({"name": "person", "color": "#111", "schema": schema(), "clock": {"device-b": 2}}),
        );

        assert_eq!(payload_of(conn, "task", "t1")["fields"], fields());
        assert_eq!(payload_of(conn, "tag_definition", "person")["schema"], schema());
        Ok(())
    })
    .expect("the wholesale applies");
}

#[test]
fn a_concurrent_task_merge_keeps_the_local_fields_and_imports_none() {
    let db = open("merge");
    db.call_blocking(|conn| {
        seed_project(conn);
        apply(
            conn,
            "task",
            "t1",
            json!({"title": "Ask", "projectId": "pa", "fields": fields(), "clock": {"device-a": 1}}),
        );

        apply(
            conn,
            "task",
            "t1",
            json!({
                "title": "Ask Ahmet",
                "projectId": "pa",
                "fields": {"Owner": {"v": "Deniz", "t": 9}},
                "clock": {"device-b": 1},
                "fieldClocks": {"title": {"device-b": 2}}
            }),
        );

        let merged = payload_of(conn, "task", "t1");
        assert_eq!(merged["title"], json!("Ask Ahmet"), "the merge ran");
        assert_eq!(merged["fields"], fields());
        assert_eq!(merged["clock"], json!({"device-a": 1, "device-b": 1}));
        Ok(())
    })
    .expect("the merge");
}

#[test]
fn a_duplicate_and_a_next_occurrence_copy_the_fields() {
    let db = open("copies");
    db.call_blocking(|conn| {
        seed_project(conn);
        apply(
            conn,
            "task",
            "t1",
            json!({
                "title": "Water the plants",
                "projectId": "pa",
                "statusId": "pa-todo",
                "dueDate": "2026-04-16",
                "repeatConfig": {"frequency": "daily", "interval": 1, "endType": "never",
                                 "completedCount": 0, "createdAt": "2026-04-01T09:00:00.000Z"},
                "fields": fields(),
                "clock": {"device-b": 1}
            }),
        );

        let duplicate = tasks::duplicate(conn, "t1", false, DEVICE, NOW)?;
        let copy = duplicate.created.first().expect("the copy");
        assert_eq!(payload_of(conn, "task", copy)["fields"], fields());

        let done = tasks::complete(
            conn,
            "t1",
            LocalDateTime::parse("2026-04-16T12:00:00").expect("a local instant"),
            DEVICE,
            NOW + 1_000,
        )?;
        let next = done.next_occurrence.expect("a next occurrence");
        assert_eq!(payload_of(conn, "task", &next.id)["fields"], fields());
        Ok(())
    })
    .expect("the copies");
}
