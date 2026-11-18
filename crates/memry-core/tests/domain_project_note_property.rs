//! A markdown note's `project` property projected onto its projects' `links`
//! (desktop's `reconcileNoteLinks`, `note-project-links-projector.ts`),
//! through the note property writer, against real SQLite.

use memry_core::domain::projects::{self, LinkItemType, NewProject};
use memry_core::domain::properties;
use memry_core::storage::repositories::sync_items::{self, InboundRecord};
use memry_core::storage::{Db, open_data};
use rusqlite::{Connection, params};
use serde_json::{Map, Value, json};

const NOW: i64 = 1_760_000_000_000;
const DEVICE: &str = "device-a";

fn open(label: &str) -> Db {
    let dir = tempfile::Builder::new()
        .prefix(&format!("memry-note-property-{label}-"))
        .tempdir()
        .expect("the scratch directory")
        .keep();
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

fn seed_note(conn: &Connection, id: &str, file_type: &str) {
    seed(
        conn,
        "note",
        id,
        json!({"title": id, "fileType": file_type, "folderPath": "",
               "properties": {"area": "work"}, "clock": {"device-b": 1}}),
    );
}

fn create_project(conn: &Connection, id: &str, name: &str, now_ms: i64) {
    let project = NewProject {
        id: Some(id),
        name,
        description: None,
        color: None,
        icon: None,
        statuses: None,
    };
    projects::create(conn, &project, DEVICE, now_ms).expect("create the project");
}

fn set_projects(conn: &Connection, note_id: &str, names: Value, now_ms: i64) {
    properties::set(conn, "note", note_id, "project", names, DEVICE, now_ms)
        .expect("the property write");
}

/// `(item type, item id, pinned, position)` of a project's links.
fn linked(conn: &Connection, project_id: &str) -> Vec<(String, String, bool, i64)> {
    projects::links(conn, project_id)
        .expect("the links")
        .into_iter()
        .map(|link| (link.item_type, link.item_id, link.pinned, link.position))
        .collect()
}

fn note_link(item_type: &str, pinned: bool, position: i64) -> (String, String, bool, i64) {
    (item_type.to_owned(), "n1".to_owned(), pinned, position)
}

/// Forgets every queued change, as a push would, so [`queued`] counts what
/// comes after. The outbox keeps one row per item until it is pushed.
fn drain(conn: &Connection) {
    conn.execute("DELETE FROM outbox", [])
        .expect("drain the queue");
}

fn queued(conn: &Connection, item_id: &str) -> i64 {
    conn.query_row(
        "SELECT count(*) FROM outbox WHERE item_id = ?1",
        params![item_id],
        |row| row.get(0),
    )
    .expect("count the queue")
}

#[test]
fn the_project_property_links_the_note_and_moves_it_between_projects() {
    let db = open("move");
    db.call_blocking(|conn| {
        create_project(conn, "pa", "Alpha", NOW);
        create_project(conn, "pb", "Beta", NOW);
        seed_note(conn, "n1", "markdown");
        drain(conn);

        // Case folds; a name matching no project links nothing.
        set_projects(conn, "n1", json!(["alpha", "Nowhere"]), NOW + 1);
        assert_eq!(linked(conn, "pa"), [note_link("note", false, 0)]);
        assert!(linked(conn, "pb").is_empty());
        assert_eq!((queued(conn, "pa"), queued(conn, "pb")), (1, 0));

        // A legacy import holds the note as `file` in Beta too; the property
        // does not name Beta, so the next write drops it.
        projects::link(conn, "pb", LinkItemType::File, "n1", DEVICE, NOW + 2)?.acknowledge();
        set_projects(conn, "n1", json!(["Alpha"]), NOW + 3);
        assert_eq!(linked(conn, "pa"), [note_link("note", false, 0)]);
        assert!(linked(conn, "pb").is_empty());

        set_projects(conn, "n1", json!(["Beta"]), NOW + 4);
        assert!(linked(conn, "pa").is_empty());
        assert_eq!(linked(conn, "pb"), [note_link("note", false, 0)]);

        set_projects(conn, "n1", json!([]), NOW + 5);
        assert!(linked(conn, "pb").is_empty());
        Ok(())
    })
    .expect("the scenario");
}

#[test]
fn a_kept_link_keeps_its_pin_and_an_unchanged_membership_queues_nothing() {
    let db = open("kept");
    db.call_blocking(|conn| {
        create_project(conn, "pa", "Alpha", NOW);
        seed_note(conn, "n1", "markdown");
        projects::link(conn, "pa", LinkItemType::Note, "n1", DEVICE, NOW + 1)?.acknowledge();
        projects::set_link_pinned(conn, "pa", "n1", true, DEVICE, NOW + 2)?.acknowledge();
        drain(conn);

        properties::set(conn, "note", "n1", "area", json!("home"), DEVICE, NOW + 3)
            .expect("an unrelated property write");
        assert_eq!(linked(conn, "pa"), [note_link("note", true, 0)]);
        assert_eq!((queued(conn, "pa"), queued(conn, "n1")), (0, 1));
        Ok(())
    })
    .expect("the scenario");
}

#[test]
fn a_shared_name_resolves_to_the_oldest_project_archived_or_not() {
    let db = open("oldest");
    db.call_blocking(|conn| {
        create_project(conn, "old", "Same", NOW);
        create_project(conn, "new", "same", NOW + 1);
        projects::set_archived(conn, "old", true, DEVICE, NOW + 2)?.acknowledge();
        seed_note(conn, "n1", "markdown");

        set_projects(conn, "n1", json!("Same"), NOW + 3);
        assert_eq!(linked(conn, "old"), [note_link("note", false, 0)]);
        assert!(linked(conn, "new").is_empty());
        Ok(())
    })
    .expect("the scenario");
}

#[test]
fn a_note_that_is_not_markdown_gains_no_link_from_its_property() {
    let db = open("pdf");
    db.call_blocking(|conn| {
        create_project(conn, "pa", "Alpha", NOW);
        seed_note(conn, "n1", "pdf");
        drain(conn);

        set_projects(conn, "n1", json!(["Alpha"]), NOW + 1);
        assert!(linked(conn, "pa").is_empty());
        assert_eq!(queued(conn, "pa"), 0);
        Ok(())
    })
    .expect("the scenario");
}

#[test]
fn an_edit_of_the_notes_file_links_like_an_edit_in_the_app() {
    let db = open("file");
    db.call_blocking(|conn| {
        create_project(conn, "pa", "Alpha", NOW);
        seed_note(conn, "n1", "markdown");
        let mut before = Map::new();
        before.insert("area".to_owned(), json!("work"));
        let mut after = before.clone();
        after.insert("project".to_owned(), json!(["Alpha"]));

        assert!(properties::mirror_file(
            conn,
            "n1",
            &before,
            after,
            DEVICE,
            NOW + 1
        )?);
        assert_eq!(linked(conn, "pa"), [note_link("note", false, 0)]);
        Ok(())
    })
    .expect("the scenario");
}
