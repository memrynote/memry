//! Projects: the read surface and the second field-merged type (T129). The
//! writes (spec 004 D2) are in `domain_projects_write.rs` and
//! `domain_projects_links.rs`.
//!
//! | Test                                             | Rule                        |
//! | ------------------------------------------------ | --------------------------- |
//! | a pulled project reads back with its statuses    | chapter 13 §13.7.4, §A.4    |
//! | the Inbox is a project carrying a flag           | §A.4                        |
//! | an archived project is out unless asked for      | the read surface            |
//! | a concurrent project merges over the nine fields | chapter 06 §6.7, §6.8       |

use std::sync::atomic::{AtomicU64, Ordering};

use memry_core::domain::projects;
use memry_core::domain::tasks::Inbound;
use memry_core::storage::repositories::sync_items::{self, InboundRecord};
use memry_core::storage::{Db, open_data};
use rusqlite::Connection;
use serde_json::{Value, json};

const NOW: i64 = 1_760_000_000_000;

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

fn record(item_id: &str, payload: Value) -> InboundRecord {
    InboundRecord {
        item_type: "project".to_owned(),
        item_id: item_id.to_owned(),
        payload_json: serde_json::to_string(&payload).expect("serialise"),
        server_cursor: Some(7),
        signer_device_id: Some("device-b".to_owned()),
        updated_at: NOW,
        deleted_at: None,
    }
}

fn apply(conn: &Connection, item_id: &str, payload: Value) {
    sync_items::apply_remote(conn, &record(item_id, payload), NOW).expect("apply");
}

#[test]
fn a_pulled_project_reads_back_with_its_statuses() {
    let db = open("projects-read");
    db.call_blocking(|conn| {
        apply(
            conn,
            "proj-1",
            json!({
                "name": "Native iOS",
                "description": "The Rust core and its shell.",
                "color": "#0ea5e9",
                "icon": "rocket",
                "position": 1,
                "isInbox": false,
                "homeNoteId": "abc123def456",
                "statuses": [
                    {"id": "todo", "name": "Todo", "color": "#888", "position": 0,
                     "isDefault": true},
                    {"id": "done", "name": "Done", "color": "#0a0", "position": 1,
                     "isDone": true}
                ],
                "clock": {"device-b": 1}
            }),
        );

        let project = projects::get(conn, "proj-1")?.expect("the project");
        assert_eq!(project.name, "Native iOS");
        assert_eq!(project.color, "#0ea5e9");
        assert_eq!(project.icon.as_deref(), Some("rocket"));
        // A note id, not a home page id (§13.11).
        assert_eq!(project.home_note_id.as_deref(), Some("abc123def456"));
        assert!(!project.is_inbox);

        let statuses = projects::statuses(conn, "proj-1")?;
        assert_eq!(statuses.len(), 2);
        assert!(statuses[0].is_default && !statuses[0].is_done);
        assert!(statuses[1].is_done);
        Ok(())
    })
    .expect("the read");
}

#[test]
fn the_inbox_is_a_project_carrying_a_flag_and_an_archived_one_is_out_by_default() {
    let db = open("projects-inbox");
    db.call_blocking(|conn| {
        assert!(projects::inbox(conn)?.is_none(), "nothing pulled yet");

        apply(
            conn,
            "proj-inbox",
            json!({"name": "Inbox", "color": "#888", "isInbox": true, "position": 0,
                   "clock": {"device-b": 1}}),
        );
        apply(
            conn,
            "proj-old",
            json!({"name": "Archived", "color": "#888", "position": 1,
                   "archivedAt": "2026-04-01T00:00:00.000Z", "clock": {"device-b": 1}}),
        );

        assert_eq!(projects::inbox(conn)?.expect("the inbox").id, "proj-inbox");
        assert_eq!(
            projects::list(conn, false)?
                .into_iter()
                .map(|project| project.id)
                .collect::<Vec<_>>(),
            vec!["proj-inbox".to_owned()]
        );
        assert_eq!(projects::list(conn, true)?.len(), 2);
        Ok(())
    })
    .expect("the inbox");
}

#[test]
fn a_concurrent_project_merges_over_the_nine_fields_including_modified_at() {
    let db = open("projects-merge");
    db.call_blocking(|conn| {
        apply(
            conn,
            "proj-1",
            json!({
                "name": "Native iOS",
                "color": "#0ea5e9",
                "position": 1,
                "modifiedAt": "2026-04-16T00:00:00.000Z",
                "clock": {"device-a": 1},
                "fieldClocks": {
                    "name": {"device-a": 1},
                    "color": {"device-a": 1},
                    "modifiedAt": {"device-a": 1}
                }
            }),
        );

        // device-b recoloured from the same ancestor; device-c renamed twice.
        // Concurrent document clocks, and each field resolves on its own total.
        let outcome = projects::apply_remote(
            conn,
            &record(
                "proj-1",
                json!({
                    "name": "Native iOS",
                    "color": "#f97316",
                    "position": 1,
                    "modifiedAt": "2026-04-17T00:00:00.000Z",
                    "clock": {"device-b": 1},
                    "fieldClocks": {
                        "name": {"device-a": 1},
                        "color": {"device-b": 2},
                        "modifiedAt": {"device-b": 2}
                    }
                }),
            ),
            NOW + 1_000,
        )?;

        assert_eq!(
            outcome,
            Inbound::Merged {
                conflicted_fields: Vec::new()
            }
        );
        let project = projects::get(conn, "proj-1")?.expect("the project");
        assert_eq!(project.name, "Native iOS");
        assert_eq!(project.color, "#f97316", "the larger total wins (§6.3)");
        Ok(())
    })
    .expect("the merge");
}

/// **Spec defect 53's shape, on `project`.** The same substitute-never-refuse
/// obligation (§13.3, data-model §A.4), over the ten fields the projector once
/// marked non-nullable — including the two nested arrays, where §13.4 makes an
/// explicit `null` a clear exactly as an explicit `[]` is.
#[test]
fn an_explicit_null_in_every_project_field_projects_instead_of_landing_corrupt() {
    let db = open("projects-null-tolerance");
    db.call_blocking(|conn| {
        // A first version with a status, so the clear below has something to
        // clear rather than passing vacuously.
        apply(
            conn,
            "proj-null",
            json!({
                "name": "Native iOS",
                "color": "#0ea5e9",
                "statuses": [{"id": "todo", "name": "Todo", "color": "#888", "position": 0}]
            }),
        );
        let seeded: i64 = conn
            .query_row(
                "SELECT count(*) FROM project_statuses WHERE project_id = 'proj-null'",
                [],
                |row| row.get(0),
            )
            .expect("count the statuses");
        assert_eq!(seeded, 1);

        let outcome = sync_items::apply_remote(
            conn,
            &record(
                "proj-null",
                json!({
                    "name": Value::Null,
                    "color": Value::Null,
                    "position": Value::Null,
                    "isInbox": Value::Null,
                    "statuses": Value::Null,
                    "links": Value::Null,
                    "clock": Value::Null,
                    "fieldClocks": Value::Null,
                    "createdAt": Value::Null,
                    "modifiedAt": Value::Null
                }),
            ),
            NOW + 1_000,
        )?;
        assert_eq!(
            outcome,
            sync_items::ApplyOutcome::Applied,
            "a substituted default, never a corrupt row"
        );

        let (name, color, position, is_inbox): (String, String, i64, i64) = conn
            .query_row(
                "SELECT name, color, position, is_inbox FROM projects WHERE id = 'proj-null'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("the project projection");
        assert_eq!(
            (name.as_str(), color.as_str(), position, is_inbox),
            ("", "", 0, 0)
        );

        let (clock, created): (Option<String>, Option<i64>) = conn
            .query_row(
                "SELECT clock, created_at FROM projects WHERE id = 'proj-null'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("the project projection");
        assert_eq!((clock, created), (None, None));

        // §13.4: an explicit null is a clear, not an absent key.
        let left: i64 = conn
            .query_row(
                "SELECT count(*) FROM project_statuses WHERE project_id = 'proj-null'",
                [],
                |row| row.get(0),
            )
            .expect("count the statuses");
        assert_eq!(left, 0, "an explicit null clears the nested rows");
        Ok(())
    })
    .expect("the null-tolerant apply");
}

/// The other half of §13.4, and the reason the clear above cannot be widened
/// into "any non-array clears": an **absent** array keeps the local rows.
#[test]
fn an_absent_nested_array_keeps_the_projected_rows() {
    let db = open("projects-absent-array");
    db.call_blocking(|conn| {
        apply(
            conn,
            "proj-keep",
            json!({
                "name": "Native iOS",
                "statuses": [{"id": "todo", "name": "Todo", "color": "#888", "position": 0}]
            }),
        );
        apply(conn, "proj-keep", json!({"name": "Renamed"}));

        let left: i64 = conn
            .query_row(
                "SELECT count(*) FROM project_statuses WHERE project_id = 'proj-keep'",
                [],
                |row| row.get(0),
            )
            .expect("count the statuses");
        assert_eq!(left, 1, "absent means the sender does not know the field");
        Ok(())
    })
    .expect("the absent array");
}
