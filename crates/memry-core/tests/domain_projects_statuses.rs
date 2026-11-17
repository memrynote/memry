//! Per-status commands, project contents and propagation targets (Step 21c2),
//! against real SQLite.
//!
//! | Test                                                         | Desktop reference                  |
//! | ------------------------------------------------------------ | ---------------------------------- |
//! | a created status goes last and is never the default          | `createStatus`                     |
//! | an update sets only the named fields and keeps unknown keys  | `updateStatus`                     |
//! | a delete drops the entry and leaves its tasks alone          | `deleteStatus`                     |
//! | a reorder writes one row per project and skips unknown ids   | `reorderStatuses`                  |
//! | contents resolve by file type and drop dangling targets      | `getProjectContents`               |
//! | an item's projects are live and oldest link first            | `getProjectsForItem`               |
//! | targets are the name and linked markdown notes before delete | `captureProjectForDelete`          |

use memry_core::domain::projects::{
    self, LinkItemType, NewProject, NewStatus, StatusPatch, TaskDisposition,
};
use memry_core::storage::repositories::sync_items::{self, InboundRecord};
use memry_core::storage::{Db, open_data};
use rusqlite::{Connection, params};
use serde_json::{Value, json};

const NOW: i64 = 1_760_000_000_000;
const NOW_ISO: &str = "2025-10-09T08:53:20.000Z";
const DEVICE: &str = "device-a";

fn open(label: &str) -> Db {
    let dir = tempfile::Builder::new()
        .prefix(&format!("memry-domain-{label}-"))
        .tempdir()
        .expect("the scratch directory")
        .keep();
    std::fs::create_dir_all(&dir).expect("the scratch directory");
    open_data(&dir.join("data.db")).expect("open data.db")
}

fn seed(conn: &Connection, item_type: &str, item_id: &str, payload: Value) {
    let record = InboundRecord {
        item_type: item_type.to_owned(),
        item_id: item_id.to_owned(),
        payload_json: serde_json::to_string(&payload).expect("serialise"),
        server_cursor: Some(7),
        signer_device_id: Some("device-b".to_owned()),
        updated_at: NOW,
        deleted_at: None,
    };
    sync_items::apply_remote(conn, &record, NOW).expect("apply");
}

/// A desktop project whose statuses carry a key this build does not model.
fn seed_project(conn: &Connection, id: &str, name: &str, links: Value) {
    seed(
        conn,
        "project",
        id,
        json!({
            "name": name, "color": "#6366f1", "position": 0,
            "statuses": [
                {"id": format!("{id}-todo"), "projectId": id, "name": "To Do",
                 "color": "#6b7280", "position": 0, "isDefault": true, "isDone": false,
                 "createdAt": "2026-01-01T00:00:00.000Z", "futureKey": "kept"},
                {"id": format!("{id}-done"), "projectId": id, "name": "Done",
                 "color": "#22c55e", "position": 4, "isDefault": false, "isDone": true,
                 "createdAt": "2026-01-01T00:00:00.000Z"}
            ],
            "links": links,
            "clock": {"device-b": 1}
        }),
    );
}

fn seed_note(conn: &Connection, id: &str, title: &str, file_type: &str) {
    seed(
        conn,
        "note",
        id,
        json!({"title": title, "fileType": file_type, "folderPath": "",
               "modifiedAt": NOW_ISO, "properties": {}, "clock": {"device-b": 1}}),
    );
}

fn link(id: &str, item_type: &str, item_id: &str, position: i64, created_at: &str) -> Value {
    json!({"id": id, "itemType": item_type, "itemId": item_id, "position": position,
           "pinned": 0, "createdAt": created_at})
}

fn payload_of(conn: &Connection, item_type: &str, item_id: &str) -> Value {
    let raw = sync_items::push_payload(conn, item_type, item_id)
        .expect("read the row")
        .expect("a payload");
    serde_json::from_str(&raw).expect("valid JSON")
}

fn outbox_count(conn: &Connection, item_id: &str) -> i64 {
    conn.query_row(
        "SELECT count(*) FROM outbox WHERE item_id = ?1",
        params![item_id],
        |row| row.get(0),
    )
    .expect("count the queue")
}

fn status_entry(conn: &Connection, project_id: &str, status_id: &str) -> Option<Value> {
    payload_of(conn, "project", project_id)["statuses"]
        .as_array()
        .expect("a statuses array")
        .iter()
        .find(|entry| entry["id"] == json!(status_id))
        .cloned()
}

#[test]
fn a_created_status_goes_last_and_is_never_the_default() {
    let db = open("status-create");
    db.call_blocking(|conn| {
        seed_project(conn, "proj-c", "Agent Test C", json!([]));
        let created = projects::create_status(
            conn,
            &NewStatus {
                project_id: "proj-c",
                name: "Review",
                color: None,
                is_done: false,
            },
            DEVICE,
            NOW,
        )?
        .acknowledge();
        assert_eq!(created.project_id, "proj-c");
        assert_eq!(
            created.position, 5,
            "one past the highest position, not the count"
        );
        assert!(!created.is_default);
        assert_eq!(created.color, "#6b7280");
        assert_eq!(created.created_at.as_deref(), Some(NOW_ISO));
        assert_eq!(created.id.len(), 21, "a nanoid, as desktop mints one");

        let entry = status_entry(conn, "proj-c", &created.id).expect("the new entry");
        assert_eq!(
            entry,
            json!({"id": created.id, "projectId": "proj-c", "name": "Review",
                   "color": "#6b7280", "position": 5, "isDefault": false, "isDone": false,
                   "createdAt": NOW_ISO})
        );
        assert_eq!(
            status_entry(conn, "proj-c", "proj-c-todo").expect("kept")["futureKey"],
            json!("kept")
        );
        assert_eq!(outbox_count(conn, "proj-c"), 1);

        let listed = projects::statuses(conn, "proj-c")?;
        assert_eq!(listed.len(), 3);
        assert_eq!(listed[2], created);
        assert_eq!(
            listed[0].created_at.as_deref(),
            Some("2026-01-01T00:00:00.000Z")
        );

        let invalid = NewStatus {
            project_id: "proj-c",
            name: " ",
            color: None,
            is_done: false,
        };
        assert!(projects::create_status(conn, &invalid, DEVICE, NOW).is_err());
        let ghost = NewStatus {
            project_id: "ghost",
            name: "X",
            color: None,
            is_done: false,
        };
        assert!(projects::create_status(conn, &ghost, DEVICE, NOW).is_err());
        assert_eq!(
            outbox_count(conn, "proj-c"),
            1,
            "a refused create writes nothing"
        );
        Ok(())
    })
    .expect("the create");
}

#[test]
fn an_update_sets_only_the_named_fields_and_keeps_unknown_keys() {
    let db = open("status-update");
    db.call_blocking(|conn| {
        seed_project(conn, "proj-u", "Agent Test U", json!([]));
        let patch = StatusPatch {
            name: Some("Backlog"),
            is_done: Some(true),
            ..StatusPatch::default()
        };
        let updated =
            projects::update_status(conn, "proj-u-todo", &patch, DEVICE, NOW)?.acknowledge();
        assert_eq!(updated.name, "Backlog");
        assert!(updated.is_done && updated.is_default);

        let entry = status_entry(conn, "proj-u", "proj-u-todo").expect("the entry");
        assert_eq!(entry["futureKey"], json!("kept"));
        assert_eq!(entry["color"], json!("#6b7280"));
        assert_eq!(
            status_entry(conn, "proj-u", "proj-u-done").expect("the other")["isDone"],
            json!(true),
            "desktop's update clears no flag on another status"
        );

        let missing = projects::update_status(conn, "ghost", &patch, DEVICE, NOW);
        assert!(matches!(
            missing,
            Err(memry_core::api::errors::StorageError::NotFound { .. })
        ));
        let bad_color = StatusPatch {
            color: Some("red"),
            ..StatusPatch::default()
        };
        assert!(projects::update_status(conn, "proj-u-todo", &bad_color, DEVICE, NOW).is_err());
        assert_eq!(outbox_count(conn, "proj-u"), 1);
        Ok(())
    })
    .expect("the update");
}

#[test]
fn a_delete_drops_the_entry_and_leaves_its_tasks_alone() {
    let db = open("status-delete");
    db.call_blocking(|conn| {
        seed_project(conn, "proj-d", "Agent Test D", json!([]));
        seed(
            conn,
            "task",
            "task-on-done",
            json!({"title": "[agent] t", "projectId": "proj-d", "statusId": "proj-d-done",
                   "priority": 0, "position": 0, "clock": {"device-b": 1}}),
        );

        let left = projects::delete_status(conn, "proj-d-done", DEVICE, NOW)?
            .expect("a delete")
            .acknowledge();
        assert_eq!(left, "proj-d");
        assert!(status_entry(conn, "proj-d", "proj-d-done").is_none());
        assert_eq!(projects::statuses(conn, "proj-d")?.len(), 1);
        assert_eq!(
            payload_of(conn, "task", "task-on-done")["statusId"],
            json!("proj-d-done"),
            "the task keeps the stale id, as desktop pushes nothing for it"
        );
        assert_eq!(outbox_count(conn, "task-on-done"), 0);

        assert!(projects::delete_status(conn, "proj-d-done", DEVICE, NOW)?.is_none());
        assert_eq!(
            outbox_count(conn, "proj-d"),
            1,
            "a missing status writes nothing"
        );
        Ok(())
    })
    .expect("the delete");
}

#[test]
fn a_reorder_writes_one_row_per_project_and_skips_unknown_ids() {
    let db = open("status-reorder");
    db.call_blocking(|conn| {
        seed_project(conn, "proj-a", "Agent Test A", json!([]));
        seed_project(conn, "proj-b", "Agent Test B", json!([]));

        assert!(projects::reorder_statuses(conn, &["proj-a-todo"], &[1, 2], DEVICE, NOW).is_err());
        assert_eq!(
            outbox_count(conn, "proj-a"),
            0,
            "a length mismatch writes nothing"
        );

        let written = projects::reorder_statuses(
            conn,
            &["proj-a-done", "ghost", "proj-b-todo", "proj-a-todo"],
            &[0, 9, 7, 1],
            DEVICE,
            NOW,
        )?;
        let moved: Vec<Vec<(String, i64)>> = written
            .into_iter()
            .map(|durable| {
                durable
                    .acknowledge()
                    .into_iter()
                    .map(|status| (status.id, status.position))
                    .collect()
            })
            .collect();
        assert_eq!(
            moved,
            vec![
                vec![("proj-a-done".to_owned(), 0), ("proj-a-todo".to_owned(), 1)],
                vec![("proj-b-todo".to_owned(), 7)],
            ]
        );
        assert_eq!(outbox_count(conn, "proj-a"), 1);
        assert_eq!(outbox_count(conn, "proj-b"), 1);
        let order: Vec<String> = projects::statuses(conn, "proj-a")?
            .into_iter()
            .map(|status| status.id)
            .collect();
        assert_eq!(order, vec!["proj-a-done", "proj-a-todo"]);
        Ok(())
    })
    .expect("the reorder");
}

#[test]
fn contents_resolve_by_file_type_and_drop_dangling_targets() {
    let db = open("contents");
    db.call_blocking(|conn| {
        seed_note(conn, "note-b", "Beta", "markdown");
        seed_note(conn, "note-a", "Alpha", "markdown");
        // Linked as `file` by the legacy importer, but the row is markdown.
        seed_note(conn, "note-legacy", "Legacy", "markdown");
        seed_note(conn, "pdf-1", "Report", "pdf");
        conn.execute(
            "INSERT INTO note_files (note_id, path, file_type, file_size, indexed_at)
             VALUES ('pdf-1', 'Report.pdf', 'pdf', 2048, 1)",
            [],
        )
        .expect("the file row");
        seed(
            conn,
            "calendar_event",
            "evt-late",
            json!({"title": "Late", "startAt": "2026-09-24T12:00:00.000Z",
                   "endAt": null, "isAllDay": true, "clock": {"device-b": 1}}),
        );
        seed(
            conn,
            "calendar_event",
            "evt-early",
            json!({"title": "Early", "startAt": "2026-09-24T09:00:00.000Z",
                   "endAt": "2026-09-24T10:00:00.000Z", "isAllDay": false,
                   "clock": {"device-b": 1}}),
        );
        let mut pinned = link("l-a", "note", "note-a", 0, "2026-01-03T00:00:00.000Z");
        pinned["pinned"] = json!(1);
        seed_project(
            conn,
            "proj-h",
            "Agent Test Hub",
            json!([
                link("l-b", "note", "note-b", 0, "2026-01-02T00:00:00.000Z"),
                pinned,
                link(
                    "l-legacy",
                    "file",
                    "note-legacy",
                    1,
                    "2026-01-01T00:00:00.000Z"
                ),
                link("l-pdf", "file", "pdf-1", 0, "2026-01-01T00:00:00.000Z"),
                link(
                    "l-gone",
                    "note",
                    "never-arrived",
                    0,
                    "2026-01-01T00:00:00.000Z"
                ),
                link(
                    "l-late",
                    "calendar_event",
                    "evt-late",
                    0,
                    "2026-01-01T00:00:00.000Z"
                ),
                link(
                    "l-early",
                    "calendar_event",
                    "evt-early",
                    5,
                    "2026-01-01T00:00:00.000Z"
                ),
                link("l-canvas", "canvas", "c-1", 0, "2026-01-01T00:00:00.000Z"),
            ]),
        );
        sync_items::apply_remote(
            conn,
            &InboundRecord {
                item_type: "calendar_event".to_owned(),
                item_id: "evt-late".to_owned(),
                payload_json: "{}".to_owned(),
                server_cursor: Some(8),
                signer_device_id: Some("device-b".to_owned()),
                updated_at: NOW,
                deleted_at: Some(NOW),
            },
            NOW,
        )
        .expect("tombstone the late event");

        let contents = projects::contents(conn, "proj-h")?;
        let notes: Vec<(&str, bool)> = contents
            .notes
            .iter()
            .map(|note| (note.id.as_str(), note.pinned))
            .collect();
        assert_eq!(
            notes,
            vec![("note-a", true), ("note-b", false), ("note-legacy", false)],
            "link position, then title; the legacy file link lands as a note"
        );
        assert_eq!(contents.notes[0].modified_at.as_deref(), Some(NOW_ISO));
        assert_eq!(contents.files.len(), 1);
        assert_eq!(contents.files[0].id, "pdf-1");
        assert_eq!(contents.files[0].file_type, "pdf");
        assert_eq!(contents.files[0].file_size, Some(2048));
        let events: Vec<&str> = contents.events.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(events, vec!["evt-early"], "a tombstoned event is dropped");
        assert_eq!(
            contents.events[0].end_at.as_deref(),
            Some("2026-09-24T10:00:00.000Z")
        );

        assert_eq!(
            projects::contents(conn, "ghost")?,
            projects::ProjectContents::default()
        );
        Ok(())
    })
    .expect("the contents");
}

#[test]
fn an_items_projects_are_live_and_oldest_link_first() {
    let db = open("for-item");
    db.call_blocking(|conn| {
        seed_project(
            conn,
            "proj-new",
            "Agent Test New",
            json!([link("l-2", "file", "file-1", 0, "2026-02-01T00:00:00.000Z")]),
        );
        seed_project(
            conn,
            "proj-old",
            "Agent Test Old",
            json!([link("l-1", "file", "file-1", 0, "2026-01-01T00:00:00.000Z")]),
        );
        seed_project(
            conn,
            "proj-gone",
            "Agent Test Gone",
            json!([link("l-0", "file", "file-1", 0, "2025-01-01T00:00:00.000Z")]),
        );
        projects::delete(conn, "proj-gone", TaskDisposition::Delete, DEVICE, NOW)?.acknowledge();

        let ids: Vec<String> = projects::projects_for_item(conn, "file", "file-1")?
            .into_iter()
            .map(|project| project.id)
            .collect();
        assert_eq!(ids, vec!["proj-old", "proj-new"]);
        assert!(projects::projects_for_item(conn, "note", "file-1")?.is_empty());
        Ok(())
    })
    .expect("the projects for an item");
}

#[test]
fn targets_are_the_name_and_linked_markdown_notes_before_a_delete() {
    let db = open("targets");
    db.call_blocking(|conn| {
        let project = NewProject {
            id: Some("proj-t"),
            name: "Agent Test Targets",
            description: None,
            color: None,
            icon: None,
            statuses: None,
        };
        projects::create(conn, &project, DEVICE, NOW)?.acknowledge();
        seed_note(conn, "note-md", "Md", "markdown");
        seed_note(conn, "img-1", "Image", "image");
        projects::link(conn, "proj-t", LinkItemType::Note, "note-md", DEVICE, NOW)?.acknowledge();
        projects::link(conn, "proj-t", LinkItemType::File, "img-1", DEVICE, NOW)?.acknowledge();

        let targets = projects::targets(conn, "proj-t")?.expect("targets");
        assert_eq!(targets.name, "Agent Test Targets");
        assert_eq!(targets.note_ids, vec!["note-md"]);

        projects::delete(conn, "proj-t", TaskDisposition::Delete, DEVICE, NOW)?.acknowledge();
        assert_eq!(projects::targets(conn, "proj-t")?, None);
        Ok(())
    })
    .expect("the targets");
}
