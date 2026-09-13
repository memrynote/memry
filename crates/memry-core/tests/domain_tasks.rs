//! Task domain writes and the inbound field merge, against real SQLite (T129).
//!
//! | Test                                              | Rule                        |
//! | ------------------------------------------------- | --------------------------- |
//! | a create seeds all fifteen field clocks           | chapter 06 §6.7             |
//! | an edit ticks the document clock and its field    | §6.3 step 2, §6.6           |
//! | an edit keeps a key this build does not model     | chapter 13 §13.2 rule 3     |
//! | a cleared due date is an explicit null            | §13.4                       |
//! | assign refuses a project the vault does not have  | FR-060                      |
//! | a dominating local clock skips the remote         | §6.3.1                      |
//! | an older remote applies wholesale, verbatim       | §6.3.1, §13.2 rule 1        |
//! | a concurrent pair merges per field and never      | §6.3, §6.5.2 P3             |
//! | re-pushes                                         |                             |
//! | two devices editing different fields both survive | FR-059                      |

use std::sync::atomic::{AtomicU64, Ordering};

use memry_core::domain::tasks::{self, Inbound, NewTask};
use memry_core::storage::repositories::sync_items::{self, InboundRecord};
use memry_core::storage::{Db, open_data};
use rusqlite::{Connection, params};
use serde_json::{Value, json};

const NOW: i64 = 1_760_000_000_000;
const DEVICE: &str = "device-a";

static SCRATCH: AtomicU64 = AtomicU64::new(0);

fn open(label: &str) -> Db {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "memry-domain-{label}-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("the scratch directory");
    open_data(&dir.join("data.db")).expect("open data.db")
}

fn task(id: &str) -> NewTask<'_> {
    NewTask {
        id,
        title: "Ship the spec",
        project_id: "proj-1",
        due_date: Some("2026-04-20"),
        due_time: None,
        priority: 2,
        repeat_config: None,
        tags: &[],
    }
}

fn payload_of(conn: &Connection, item_type: &str, item_id: &str) -> Value {
    let raw = sync_items::push_payload(conn, item_type, item_id)
        .expect("read the row")
        .expect("a payload");
    serde_json::from_str(&raw).expect("valid JSON")
}

fn outbox_rows(conn: &Connection, item_id: &str) -> i64 {
    conn.query_row(
        "SELECT count(*) FROM outbox WHERE item_id = ?1",
        params![item_id],
        |row| row.get(0),
    )
    .expect("count the queue")
}

fn inbound(item_type: &str, item_id: &str, payload: Value) -> InboundRecord {
    InboundRecord {
        item_type: item_type.to_owned(),
        item_id: item_id.to_owned(),
        payload_json: serde_json::to_string(&payload).expect("serialise"),
        server_cursor: Some(42),
        signer_device_id: Some("device-b".to_owned()),
        updated_at: NOW,
        deleted_at: None,
    }
}

/// A project row, so `assign` and the views have one to resolve.
fn seed_project(conn: &Connection, id: &str) {
    sync_items::apply_remote(
        conn,
        &inbound(
            "project",
            id,
            json!({"name": "Native iOS", "color": "#0ea5e9", "clock": {"device-b": 1}}),
        ),
        NOW,
    )
    .expect("apply the project");
}

#[test]
fn a_create_seeds_every_syncable_field_clock_from_the_document_clock() {
    let db = open("tasks-create");
    db.call_blocking(|conn| {
        let stored = tasks::create(conn, &task("task1"), DEVICE, NOW)?.acknowledge();

        // One set of bytes: what the call returned, what the column holds and
        // what a push rebuilds from the live row are one string (§6.5.2 P2).
        assert_eq!(
            sync_items::push_payload(conn, "task", "task1")?.as_deref(),
            Some(stored.as_str())
        );

        let parsed: Value = serde_json::from_str(&stored).expect("valid JSON");
        assert_eq!(parsed["clock"], json!({"device-a": 1}));
        let clocks = parsed["fieldClocks"].as_object().expect("field clocks");
        assert_eq!(clocks.len(), 15, "all fifteen (§6.7)");
        assert_eq!(clocks["title"], json!({"device-a": 1}));
        assert_eq!(clocks["archivedAt"], json!({"device-a": 1}));
        // A create knows of no due time to clear, so the key is absent rather
        // than null (§13.4).
        assert!(parsed.get("dueTime").is_none());

        let (title, due, project): (String, Option<String>, String) = conn
            .query_row(
                "SELECT title, due_date, project_id FROM tasks WHERE id = 'task1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("the projection row");
        assert_eq!(title, "Ship the spec");
        assert_eq!(due.as_deref(), Some("2026-04-20"));
        assert_eq!(project, "proj-1");
        assert_eq!(outbox_rows(conn, "task1"), 1);
        Ok(())
    })
    .expect("the create");
}

#[test]
fn an_edit_ticks_the_document_clock_and_only_the_field_it_changed() {
    let db = open("tasks-edit");
    db.call_blocking(|conn| {
        tasks::create(conn, &task("task1"), DEVICE, NOW)?;
        tasks::set_title(conn, "task1", "Renamed", DEVICE, NOW + 1_000)?;

        let parsed = payload_of(conn, "task", "task1");
        assert_eq!(parsed["title"], json!("Renamed"));
        assert_eq!(parsed["clock"], json!({"device-a": 2}));
        assert_eq!(parsed["fieldClocks"]["title"], json!({"device-a": 2}));
        // Untouched fields keep the seeded tick: a tick there would win a tie
        // on a field this device never edited.
        assert_eq!(parsed["fieldClocks"]["dueDate"], json!({"device-a": 1}));
        // `modifiedAt` is not one of `TASK_SYNCABLE_FIELDS`, so it has no clock.
        assert!(parsed["fieldClocks"].get("modifiedAt").is_none());
        Ok(())
    })
    .expect("the edit");
}

#[test]
fn an_edit_keeps_a_key_this_build_does_not_model_and_clears_with_an_explicit_null() {
    let db = open("tasks-unknown");
    db.call_blocking(|conn| {
        // A newer desktop's payload, applied and then edited locally.
        sync_items::apply_remote(
            conn,
            &inbound(
                "task",
                "task1",
                json!({
                    "title": "From desktop",
                    "projectId": "proj-1",
                    "dueDate": "2026-04-20",
                    "linkedCanvasIds": ["canvas-1"],
                    "someFutureField": {"kept": true},
                    "clock": {"device-b": 1},
                    "fieldClocks": {"title": {"device-b": 1}}
                }),
            ),
            NOW,
        )?;

        tasks::set_due(conn, "task1", None, None, DEVICE, NOW + 1_000)?;

        let parsed = payload_of(conn, "task", "task1");
        assert_eq!(parsed["someFutureField"], json!({"kept": true}));
        assert_eq!(parsed["linkedCanvasIds"], json!(["canvas-1"]));
        // `null` is the explicit clear; an absent key would leave the due date
        // standing on every other device (§13.4).
        assert_eq!(parsed["dueDate"], Value::Null);
        assert_eq!(parsed["dueTime"], Value::Null);
        assert_eq!(parsed["clock"], json!({"device-a": 1, "device-b": 1}));
        Ok(())
    })
    .expect("the edit");
}

#[test]
fn assign_refuses_a_project_the_vault_does_not_have() {
    let db = open("tasks-assign");
    db.call_blocking(|conn| {
        tasks::create(conn, &task("task1"), DEVICE, NOW)?;
        assert!(tasks::assign(conn, "task1", "proj-missing", DEVICE, NOW).is_err());
        // Nothing was written by the refusal.
        assert_eq!(outbox_rows(conn, "task1"), 1);

        seed_project(conn, "proj-2");
        tasks::assign(conn, "task1", "proj-2", DEVICE, NOW + 1_000)?;
        assert_eq!(
            payload_of(conn, "task", "task1")["projectId"],
            json!("proj-2")
        );
        Ok(())
    })
    .expect("the assign");
}

#[test]
fn a_dominating_local_clock_skips_the_remote_entirely() {
    let db = open("tasks-skip");
    db.call_blocking(|conn| {
        tasks::create(conn, &task("task1"), DEVICE, NOW)?;
        tasks::set_title(conn, "task1", "Local wins", DEVICE, NOW + 1_000)?;

        let outcome = tasks::apply_remote(
            conn,
            &inbound(
                "task",
                "task1",
                json!({"title": "Stale", "clock": {"device-a": 1}}),
            ),
            NOW + 2_000,
        )?;

        assert_eq!(outcome, Inbound::Skipped);
        assert_eq!(
            payload_of(conn, "task", "task1")["title"],
            json!("Local wins")
        );
        Ok(())
    })
    .expect("the skip");
}

#[test]
fn a_remote_that_dominates_applies_wholesale_and_verbatim() {
    let db = open("tasks-apply");
    db.call_blocking(|conn| {
        tasks::create(conn, &task("task1"), DEVICE, NOW)?;

        let record = inbound(
            "task",
            "task1",
            json!({
                "title": "From desktop",
                "projectId": "proj-1",
                "clock": {"device-a": 1, "device-b": 1},
                "fieldClocks": {"title": {"device-a": 1, "device-b": 1}},
                "anUnknownKey": 7
            }),
        );
        let outcome = tasks::apply_remote(conn, &record, NOW + 1_000)?;

        assert_eq!(outcome, Inbound::Applied);
        // §13.2 rule 1: the bytes are the remote's, exactly as received.
        assert_eq!(
            sync_items::push_payload(conn, "task", "task1")?.as_deref(),
            Some(record.payload_json.as_str())
        );
        // §6.3.1: on the apply path the remote's field clocks are stored
        // verbatim, so the fifteen the create seeded are gone.
        let parsed = payload_of(conn, "task", "task1");
        assert_eq!(parsed["fieldClocks"].as_object().expect("clocks").len(), 1);
        Ok(())
    })
    .expect("the apply");
}

#[test]
fn a_concurrent_pair_merges_per_field_stores_the_union_clock_and_never_re_pushes() {
    let db = open("tasks-merge");
    db.call_blocking(|conn| {
        tasks::create(conn, &task("task1"), DEVICE, NOW)?;
        // Local: device-a retitles. `title` reaches {device-a: 2}.
        tasks::set_title(conn, "task1", "Local title", DEVICE, NOW + 1_000)?;
        let queued = outbox_rows(conn, "task1");

        // Remote: device-b moved the due date from the create's own state, so
        // `dueDate` reaches {device-a: 1, device-b: 1} and `title` stays at
        // {device-a: 1}. The document clocks are concurrent.
        let outcome = tasks::apply_remote(
            conn,
            &inbound(
                "task",
                "task1",
                json!({
                    "title": "Ship the spec",
                    "dueDate": "2026-05-01",
                    "projectId": "proj-1",
                    "clock": {"device-a": 1, "device-b": 1},
                    "fieldClocks": {
                        "title": {"device-a": 1},
                        "dueDate": {"device-a": 1, "device-b": 1}
                    }
                }),
            ),
            NOW + 2_000,
        )?;

        assert_eq!(
            outcome,
            Inbound::Merged {
                conflicted_fields: Vec::new()
            },
            "unequal totals resolve by the larger total and are not conflicts (§6.5.4)"
        );

        let parsed = payload_of(conn, "task", "task1");
        // FR-059: both edits survive.
        assert_eq!(parsed["title"], json!("Local title"));
        assert_eq!(parsed["dueDate"], json!("2026-05-01"));
        // §6.3 step 7 and §6.3.1: the union, on the document and on the field.
        assert_eq!(parsed["clock"], json!({"device-a": 2, "device-b": 1}));
        assert_eq!(
            parsed["fieldClocks"]["dueDate"],
            json!({"device-a": 1, "device-b": 1})
        );
        assert_eq!(parsed["fieldClocks"]["title"], json!({"device-a": 2}));

        // §6.5.2 P3: the merging device does not re-push. A queue row here is
        // the §6.5.1 case-3c divergence coming back.
        assert_eq!(outbox_rows(conn, "task1"), queued);

        // The server's bookkeeping still lands, so the cursor is not lost.
        let cursor: Option<i64> = conn
            .query_row(
                "SELECT server_cursor FROM sync_items WHERE item_type = 'task' \
                 AND item_id = 'task1'",
                [],
                |row| row.get(0),
            )
            .expect("the sync item row");
        assert_eq!(cursor, Some(42));

        // The projection followed the merge.
        let (title, due): (String, Option<String>) = conn
            .query_row(
                "SELECT title, due_date FROM tasks WHERE id = 'task1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("the projection row");
        assert_eq!(title, "Local title");
        assert_eq!(due.as_deref(), Some("2026-05-01"));
        Ok(())
    })
    .expect("the merge");
}

#[test]
fn a_tied_concurrent_field_is_reported_as_a_conflict_and_the_remote_wins() {
    let db = open("tasks-conflict");
    db.call_blocking(|conn| {
        tasks::create(conn, &task("task1"), DEVICE, NOW)?;
        tasks::set_title(conn, "task1", "Local title", DEVICE, NOW + 1_000)?;

        // `title` at {device-b: 2} against the local {device-a: 2}: equal
        // totals, concurrent, differing values — §6.3 step 6.
        let outcome = tasks::apply_remote(
            conn,
            &inbound(
                "task",
                "task1",
                json!({
                    "title": "Remote title",
                    "clock": {"device-b": 2},
                    "fieldClocks": {"title": {"device-b": 2}}
                }),
            ),
            NOW + 2_000,
        )?;

        assert_eq!(
            outcome,
            Inbound::Merged {
                conflicted_fields: vec!["title".to_owned()]
            }
        );
        // Remote is the default winner on every tie (§6.3 step 5).
        assert_eq!(
            payload_of(conn, "task", "task1")["title"],
            json!("Remote title")
        );
        Ok(())
    })
    .expect("the conflict");
}

#[test]
fn a_tombstone_is_applied_rather_than_merged() {
    let db = open("tasks-tombstone");
    db.call_blocking(|conn| {
        tasks::create(conn, &task("task1"), DEVICE, NOW)?;
        let mut record = inbound("task", "task1", json!({"clock": {"device-b": 1}}));
        record.deleted_at = Some(NOW + 1_000);

        assert_eq!(
            tasks::apply_remote(conn, &record, NOW + 1_000)?,
            Inbound::Applied
        );
        let deleted: Option<i64> = conn
            .query_row(
                "SELECT deleted_at FROM tasks WHERE id = 'task1'",
                [],
                |row| row.get(0),
            )
            .expect("the projection row");
        assert_eq!(deleted, Some(NOW + 1_000));
        Ok(())
    })
    .expect("the tombstone");
}

#[test]
fn a_remote_payload_that_will_not_parse_is_recorded_corrupt_and_never_skipped() {
    let db = open("tasks-corrupt");
    db.call_blocking(|conn| {
        tasks::create(conn, &task("task1"), DEVICE, NOW)?;
        let mut record = inbound("task", "task1", json!({}));
        record.payload_json = "{not json".to_owned();

        assert!(matches!(
            tasks::apply_remote(conn, &record, NOW + 1_000)?,
            Inbound::Corrupt { .. }
        ));
        let reason: Option<String> = conn
            .query_row(
                "SELECT corrupt_reason FROM sync_items WHERE item_type = 'task' \
                 AND item_id = 'task1'",
                [],
                |row| row.get(0),
            )
            .expect("the sync item row");
        assert!(reason.is_some(), "§13.2 rule 5: flagged, not skipped");
        Ok(())
    })
    .expect("the corrupt apply");
}

/// **Spec defect 53's shape, on `task`.** A payload carrying an explicit
/// `null` in every field the projector once marked non-nullable projects
/// successfully rather than landing corrupt.
///
/// §13.3's forward tolerance and data-model §A.4 both oblige a projector to
/// **substitute** the column default and never to refuse the item. The
/// identical mistake on `tag_definition.icon` made 146 of 524 real rows
/// corrupt on the first pull of a real account, and no committed vector
/// carries a null in any of these — which is why only real data would have
/// found it.
#[test]
fn an_explicit_null_in_every_task_field_projects_instead_of_landing_corrupt() {
    let db = open("tasks-null-tolerance");
    db.call_blocking(|conn| {
        let outcome = sync_items::apply_remote(
            conn,
            &inbound(
                "task",
                "task-null",
                json!({
                    "title": Value::Null,
                    "projectId": Value::Null,
                    "priority": Value::Null,
                    "position": Value::Null,
                    "tags": Value::Null,
                    "linkedNoteIds": Value::Null,
                    "linkedCanvasIds": Value::Null,
                    "clock": Value::Null,
                    "fieldClocks": Value::Null,
                    "createdAt": Value::Null,
                    "modifiedAt": Value::Null
                }),
            ),
            NOW,
        )?;
        assert_eq!(
            outcome,
            sync_items::ApplyOutcome::Applied,
            "a substituted default, never a corrupt row"
        );

        // The `NOT NULL` columns took their declared defaults; the nullable
        // ones took NULL. Either way the payload is stored verbatim, so a
        // later build that models the field rebuilds the column from it.
        let (title, project_id, priority, position): (String, String, i64, i64) = conn
            .query_row(
                "SELECT title, project_id, priority, position FROM tasks WHERE id = 'task-null'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("the task projection");
        assert_eq!(
            (title.as_str(), project_id.as_str(), priority, position),
            ("", "", 0, 0)
        );

        let (tags, clock, created): (Option<String>, Option<String>, Option<i64>) = conn
            .query_row(
                "SELECT tags, clock, created_at FROM tasks WHERE id = 'task-null'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("the task projection");
        assert_eq!((tags, clock, created), (None, None, None));
        Ok(())
    })
    .expect("the null-tolerant apply");
}
