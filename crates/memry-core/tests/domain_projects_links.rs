//! The project hub's links (spec 004 D2), against real SQLite.
//!
//! A markdown note's membership is its `project` property on desktop, not a
//! `links` entry (`apps/desktop/src/main/tasks/project-item-links.ts`), so
//! these tests assert both halves.
//!
//! | Test                                                      | Desktop reference            |
//! | --------------------------------------------------------- | ---------------------------- |
//! | an event and a file link through the links array only     | `linkItemToProject`          |
//! | a markdown note links through its project property too    | `linkProjectItem`            |
//! | a note that is not markdown links like a file             | `isMarkdownNote`             |
//! | a pin is a number on the wire and reads back from desktop | `setProjectLinkPinned`       |
//! | a rename and a delete rewrite linked notes' names         | `propagateProjectRename`     |

use std::sync::atomic::{AtomicU64, Ordering};

use memry_core::domain::projects::{self, LinkItemType, NewProject, ProjectEdit, TaskDisposition};
use memry_core::storage::repositories::sync_items::{self, InboundRecord};
use memry_core::storage::{Db, open_data};
use rusqlite::{Connection, params};
use serde_json::{Value, json};

const NOW: i64 = 1_760_000_000_000;
const NOW_ISO: &str = "2025-10-09T08:53:20.000Z";
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

fn seed_note(conn: &Connection, id: &str, file_type: &str, properties: Value) {
    seed(
        conn,
        "note",
        id,
        json!({"title": id, "fileType": file_type, "folderPath": "",
               "properties": properties, "clock": {"device-b": 1}}),
    );
}

fn create_project(conn: &Connection, id: &str, name: &str) {
    let project = NewProject {
        id: Some(id),
        name,
        description: None,
        color: None,
        icon: None,
        statuses: None,
    };
    projects::create(conn, &project, DEVICE, NOW).expect("create the project");
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

fn linked(conn: &Connection, project_id: &str) -> Vec<(String, String, bool)> {
    projects::links(conn, project_id)
        .expect("the links")
        .into_iter()
        .map(|link| (link.item_type, link.item_id, link.pinned))
        .collect()
}

#[test]
fn an_event_and_a_file_link_through_the_links_array_only() {
    let db = open("links-table");
    db.call_blocking(|conn| {
        create_project(conn, "proj-l", "Agent Test Links");
        seed_note(conn, "file-1", "pdf", json!({}));

        projects::link(
            conn,
            "proj-l",
            LinkItemType::CalendarEvent,
            "event-1",
            DEVICE,
            NOW,
        )?;
        projects::link(conn, "proj-l", LinkItemType::File, "file-1", DEVICE, NOW)?;
        // A second link to the same item adds no second entry.
        projects::link(conn, "proj-l", LinkItemType::File, "file-1", DEVICE, NOW)?;

        let payload = payload_of(conn, "project", "proj-l");
        let entries = payload["links"].as_array().expect("links");
        assert_eq!(entries.len(), 2);
        let event = &entries[0];
        assert_eq!(event["id"].as_str().map(str::len), Some(21));
        assert_eq!(
            (
                &event["projectId"],
                &event["itemType"],
                &event["itemId"],
                &event["position"],
                &event["pinned"],
                &event["createdAt"]
            ),
            (
                &json!("proj-l"),
                &json!("calendar_event"),
                &json!("event-1"),
                &json!(0),
                &json!(0),
                &json!(NOW_ISO)
            )
        );
        assert_eq!(payload["clock"], json!({"device-a": 4}));
        assert!(payload["fieldClocks"].get("links").is_none());
        assert_eq!(outbox_count(conn, "proj-l"), 1, "collapsed per item");
        assert_eq!(outbox_count(conn, "file-1"), 0, "no note write for a file");

        projects::unlink(
            conn,
            "proj-l",
            LinkItemType::CalendarEvent,
            "event-1",
            DEVICE,
            NOW,
        )?;
        assert_eq!(
            linked(conn, "proj-l"),
            vec![("file".to_owned(), "file-1".to_owned(), false)]
        );
        Ok(())
    })
    .expect("the table links");
}

#[test]
fn a_markdown_note_links_through_its_project_property_and_a_mirrored_entry() {
    let db = open("links-markdown");
    db.call_blocking(|conn| {
        create_project(conn, "proj-m", "Agent Test Hub");
        seed_note(
            conn,
            "note-1",
            "markdown",
            json!({"status": "draft", "project": "Other"}),
        );

        projects::link(conn, "proj-m", LinkItemType::Note, "note-1", DEVICE, NOW)?;

        let note = payload_of(conn, "note", "note-1");
        assert_eq!(
            note["properties"],
            json!({"status": "draft", "project": ["Other", "Agent Test Hub"]}),
            "a legacy bare string widens to a list; other properties kept"
        );
        assert_eq!(note["clock"], json!({"device-b": 1, "device-a": 1}));
        assert_eq!(outbox_count(conn, "note-1"), 1);
        assert_eq!(
            linked(conn, "proj-m"),
            vec![("note".to_owned(), "note-1".to_owned(), false)]
        );

        // Desktop re-derives the row under its own id and item type `file`
        // (a legacy import); unlinking still finds it by item id.
        seed(
            conn,
            "project",
            "proj-m",
            json!({"name": "Agent Test Hub", "color": "#6366f1",
                   "clock": {"device-a": 2, "device-b": 1},
                   "links": [{"id": "desktop-row", "projectId": "proj-m", "itemType": "file",
                              "itemId": "note-1", "position": 0, "pinned": 1}]}),
        );
        projects::unlink(conn, "proj-m", LinkItemType::Note, "note-1", DEVICE, NOW)?;

        assert_eq!(
            payload_of(conn, "note", "note-1")["properties"],
            json!({"status": "draft", "project": ["Other"]})
        );
        assert!(linked(conn, "proj-m").is_empty());
        Ok(())
    })
    .expect("the markdown link");
}

#[test]
fn a_note_that_is_not_markdown_links_like_a_file() {
    let db = open("links-binary-note");
    db.call_blocking(|conn| {
        create_project(conn, "proj-b", "Agent Test Binary");
        seed_note(conn, "image-1", "image", json!({}));
        projects::link(conn, "proj-b", LinkItemType::Note, "image-1", DEVICE, NOW)?;
        assert_eq!(outbox_count(conn, "image-1"), 0);
        assert_eq!(
            linked(conn, "proj-b"),
            vec![("note".to_owned(), "image-1".to_owned(), false)]
        );
        Ok(())
    })
    .expect("the binary note link");
}

#[test]
fn a_pin_is_a_number_on_the_wire_and_a_desktop_pin_reads_back() {
    let db = open("links-pin");
    db.call_blocking(|conn| {
        seed(
            conn,
            "project",
            "proj-p",
            json!({"name": "Agent Test Pin", "color": "#6366f1", "clock": {"device-b": 1},
            "links": [
                {"id": "l-2", "projectId": "proj-p", "itemType": "calendar_event",
                 "itemId": "event-2", "position": 1, "pinned": 1,
                 "createdAt": "2026-01-02T00:00:00.000Z"},
                {"id": "l-1", "itemType": "file", "itemId": "file-1", "position": 0}
            ]}),
        );
        assert_eq!(
            linked(conn, "proj-p"),
            vec![
                ("file".to_owned(), "file-1".to_owned(), false),
                ("calendar_event".to_owned(), "event-2".to_owned(), true),
            ],
            "position order; a missing pin (pre-hub client) is unpinned"
        );

        projects::set_link_pinned(conn, "proj-p", "file-1", true, DEVICE, NOW)?;
        projects::set_link_pinned(conn, "proj-p", "event-2", false, DEVICE, NOW)?;
        let entries = payload_of(conn, "project", "proj-p")["links"].clone();
        assert_eq!(entries[0]["pinned"], json!(0));
        assert_eq!(entries[1]["pinned"], json!(1));
        assert_eq!(entries[0]["createdAt"], json!("2026-01-02T00:00:00.000Z"));

        assert!(projects::set_link_pinned(conn, "proj-p", "ghost", true, DEVICE, NOW).is_err());
        Ok(())
    })
    .expect("the pin");
}

#[test]
fn a_rename_and_a_delete_rewrite_the_names_on_linked_markdown_notes() {
    let db = open("links-propagate");
    db.call_blocking(|conn| {
        create_project(conn, "proj-n", "Agent Test Old");
        seed_note(conn, "note-a", "markdown", json!({}));
        seed_note(
            conn,
            "note-b",
            "markdown",
            json!({"project": ["agent test old", "Keep"]}),
        );
        projects::link(conn, "proj-n", LinkItemType::Note, "note-a", DEVICE, NOW)?;
        projects::link(conn, "proj-n", LinkItemType::Note, "note-b", DEVICE, NOW)?;
        assert_eq!(
            payload_of(conn, "note", "note-b")["properties"]["project"],
            json!(["agent test old", "Keep"]),
            "already named, case folded: no second entry"
        );

        let rename = ProjectEdit {
            name: Some("Agent Test New"),
            ..ProjectEdit::default()
        };
        projects::update(conn, "proj-n", &rename, DEVICE, NOW)?;
        assert_eq!(
            payload_of(conn, "note", "note-a")["properties"]["project"],
            json!(["Agent Test New"])
        );
        assert_eq!(
            payload_of(conn, "note", "note-b")["properties"]["project"],
            json!(["Agent Test New", "Keep"])
        );

        projects::delete(conn, "proj-n", TaskDisposition::Delete, DEVICE, NOW)?;
        assert_eq!(
            payload_of(conn, "note", "note-a")["properties"]["project"],
            json!([])
        );
        assert_eq!(
            payload_of(conn, "note", "note-b")["properties"]["project"],
            json!(["Keep"])
        );
        Ok(())
    })
    .expect("the propagation");
}
