//! Template domain writes, and the note a template creates (T126).
//!
//! | Test                                       | Rule                            |
//! | ------------------------------------------ | ------------------------------- |
//! | a create writes the template and queues it | FR-030, §A.2                    |
//! | the body is copied verbatim, never parsed  | chapter 12 §12.1.2, §12.2       |
//! | the seed survives for the editor           | data-model §A.3                 |
//! | template properties are not applied        | §13.7.6, shape unstated         |
//! | a missing or deleted template writes nothing | one transaction               |

use std::sync::atomic::{AtomicU64, Ordering};

use memry_core::domain::templates::{self, NewTemplate, NoteFromTemplate};
use memry_core::storage::repositories::sync_items;
use memry_core::storage::{Db, open_data};
use rusqlite::Connection;
use serde_json::{Value, json};

const NOW: i64 = 1_760_000_000_000;
const DEVICE: &str = "device-a";

/// Two blocks and a list marker: markdown this tier must not understand.
const BODY: &str = "# Daily\n\n- [ ] one\n- [ ] two\n";

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

fn template(id: &str) -> NewTemplate<'_> {
    NewTemplate {
        id,
        name: "Daily",
        description: Some("the daily page"),
        icon: None,
        content: BODY,
    }
}

fn payload_of(conn: &Connection, item_type: &str, item_id: &str) -> Value {
    let raw = sync_items::push_payload(conn, item_type, item_id)
        .expect("read the row")
        .expect("a payload");
    serde_json::from_str(&raw).expect("valid JSON")
}

#[test]
fn a_create_writes_the_template_its_projection_and_its_queue_row() {
    let db = open("templates-create");
    db.call_blocking(|conn| {
        templates::create(conn, &template("tpl1"), DEVICE, NOW)?.acknowledge();

        let stored = payload_of(conn, "template", "tpl1");
        assert_eq!(stored["name"], json!("Daily"));
        assert_eq!(stored["description"], json!("the daily page"));
        assert_eq!(stored["icon"], Value::Null);
        assert_eq!(stored["content"], json!(BODY));
        assert_eq!(stored["clock"], json!({"device-a": 1}));

        let (name, content): (String, String) = conn
            .query_row(
                "SELECT name, content FROM templates WHERE id = 'tpl1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("the projection row");
        assert_eq!(name, "Daily");
        assert_eq!(content, BODY);

        templates::rename(conn, "tpl1", "Daily page", DEVICE, NOW + 1)?.acknowledge();
        let renamed = payload_of(conn, "template", "tpl1");
        assert_eq!(renamed["name"], json!("Daily page"));
        assert_eq!(renamed["content"], json!(BODY), "the body is untouched");
        assert_eq!(renamed["clock"], json!({"device-a": 2}));
        Ok(())
    })
    .expect("create");
}

#[test]
fn creating_a_note_from_a_template_copies_the_body_verbatim_and_parses_none_of_it() {
    let db = open("templates-apply");
    db.call_blocking(|conn| {
        // A template as a newer peer wrote it: tags to copy, a `properties`
        // array whose element shape no chapter states, and a key this build
        // does not model at all.
        sync_items::apply_remote(
            conn,
            &sync_items::InboundRecord {
                item_type: "template".to_owned(),
                item_id: "tpl1".to_owned(),
                payload_json: json!({
                    "name": "Daily",
                    "content": BODY,
                    "tags": ["journal", "daily"],
                    "properties": [
                        {"name": "mood", "type": "text", "value": "calm"},
                        {"name": "rating", "type": "rating", "value": 4, "options": ["a"]},
                        {"name": "done", "type": "checkbox"},
                    ],
                    "coverImage": {"url": "memry://cover/1"},
                })
                .to_string(),
                server_cursor: Some(3),
                signer_device_id: Some("device-b".to_owned()),
                updated_at: NOW,
                deleted_at: None,
            },
            NOW,
        )?;

        templates::create_note(
            conn,
            &NoteFromTemplate {
                template_id: "tpl1",
                note_id: "note1",
                title: "Monday",
                folder_path: Some("Journal"),
            },
            DEVICE,
            NOW + 1,
        )?
        .acknowledge();

        let note = payload_of(conn, "note", "note1");
        assert_eq!(note["title"], json!("Monday"));
        assert_eq!(note["folderPath"], json!("Journal"));
        // Carve-out A: the create record carries the body, byte for byte, and
        // the core neither parsed nor re-emitted a single character of it.
        assert_eq!(note["content"], json!(BODY));
        assert_eq!(note["tags"], json!(["journal", "daily"]));
        // §13.7.6: the array becomes the note's free-form record by `name` and
        // `value` only. `type` and `options` are dropped — a
        // `property_definition` carries the type, and §13.7.9 forbids deriving
        // a JSON type from a type name. `value: z.unknown()`, so a number is
        // as legal as a string, and an absent `value` is an explicit null.
        assert_eq!(
            note["properties"],
            json!({"mood": "calm", "rating": 4, "done": null})
        );

        // §A.3: the seed is the only copy of what the user asked for until the
        // editor has seeded the document, and `text` stays empty because it is
        // derived from a Yjs log that does not exist yet.
        let (text, seed): (String, Option<String>) = conn
            .query_row(
                "SELECT text, seed_markdown FROM note_bodies WHERE note_id = 'note1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("the body row");
        assert_eq!(text, "");
        assert_eq!(seed.as_deref(), Some(BODY));

        // The template itself was only read.
        assert_eq!(
            payload_of(conn, "template", "tpl1")["coverImage"],
            json!({"url": "memry://cover/1"})
        );
        Ok(())
    })
    .expect("apply");
}

#[test]
fn a_template_that_cannot_be_read_produces_no_note_at_all() {
    let db = open("templates-missing");
    db.call_blocking(|conn| {
        let request = NoteFromTemplate {
            template_id: "tpl1",
            note_id: "note1",
            title: "Monday",
            folder_path: None,
        };
        assert!(templates::create_note(conn, &request, DEVICE, NOW).is_err());

        templates::create(conn, &template("tpl1"), DEVICE, NOW)?;
        templates::delete(conn, "tpl1", DEVICE, NOW + 1)?.acknowledge();
        conn.execute("DELETE FROM outbox", []).expect("drain");
        assert!(
            templates::create_note(conn, &request, DEVICE, NOW + 2).is_err(),
            "a deleted template is not a seed"
        );

        assert!(sync_items::load(conn, "note", "note1")?.is_none());
        let queued: i64 = conn
            .query_row("SELECT count(*) FROM outbox", [], |row| row.get(0))
            .expect("count");
        assert_eq!(queued, 0, "a refused template application queues nothing");
        Ok(())
    })
    .expect("missing");
}

#[test]
fn a_template_field_of_the_wrong_shape_is_an_error_and_never_an_empty_default() {
    let db = open("templates-wrong-shape");
    db.call_blocking(|conn| {
        sync_items::apply_remote(
            conn,
            &sync_items::InboundRecord {
                item_type: "template".to_owned(),
                item_id: "tpl1".to_owned(),
                // `content` has no reader constraint that rejects this, so the
                // row applies; the seed read is where it has to be caught.
                payload_json: json!({"name": "Daily", "content": 7}).to_string(),
                server_cursor: Some(4),
                signer_device_id: None,
                updated_at: NOW,
                deleted_at: None,
            },
            NOW,
        )?;

        let refused = templates::create_note(
            conn,
            &NoteFromTemplate {
                template_id: "tpl1",
                note_id: "note1",
                title: "Monday",
                folder_path: None,
            },
            DEVICE,
            NOW + 1,
        );
        assert!(
            refused.is_err(),
            "an unreadable field is a hard error, never a silently empty note"
        );
        assert!(sync_items::load(conn, "note", "note1")?.is_none());
        Ok(())
    })
    .expect("wrong shape");
}
