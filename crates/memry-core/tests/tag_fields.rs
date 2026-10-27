//! A note's tag fields (§13.7.7.1), read with its metadata: desktop's
//! `buildFieldGroups` over `resolveTagSchemas`.
//!
//! Real SQLite. Definitions arrive the way desktop's do, as synced
//! `tag_definition` payloads; notes are written through the domain.

use memry_core::domain::note_meta;
use memry_core::domain::notes::{self, NewNote};
use memry_core::storage::repositories::sync_items::{self, InboundRecord};
use memry_core::storage::{Db, open_data};
use rusqlite::Connection;
use serde_json::{Map, Value, json};

const NOW: i64 = 1_760_000_000_000;

fn open() -> Db {
    let dir = tempfile::Builder::new()
        .prefix("memry-tag-fields-")
        .tempdir()
        .expect("the scratch directory")
        .keep();
    std::fs::create_dir_all(&dir).expect("the scratch directory");
    open_data(&dir.join("data.db")).expect("open data.db")
}

fn define_tag(db: &Db, name: &str, schema: Value) {
    let record = InboundRecord {
        item_type: "tag_definition".to_owned(),
        item_id: name.to_owned(),
        payload_json: json!({ "name": name, "color": "blue", "schema": schema }).to_string(),
        server_cursor: Some(1),
        signer_device_id: Some("device-b".to_owned()),
        updated_at: NOW,
        deleted_at: None,
    };
    db.call_blocking(move |conn| sync_items::apply_remote(conn, &record, NOW).map(|_| ()))
        .expect("the definition");
}

fn define_property(db: &Db, name: &str, type_name: &str) {
    db.call_blocking(|conn: &mut Connection| {
        conn.execute(
            "INSERT INTO property_definitions (name, type) VALUES (?1, ?2)",
            (name, type_name),
        )
        .expect("the property definition");
        Ok(())
    })
    .expect("the property definition");
}

fn note(db: &Db, tags: &[&str], properties: Value) -> note_meta::NoteMetadata {
    let tags: Vec<String> = tags.iter().map(|t| (*t).to_owned()).collect();
    let properties: Map<String, Value> = properties.as_object().cloned().unwrap_or_default();
    db.call_blocking(|conn: &mut Connection| {
        notes::create(
            conn,
            &NewNote {
                id: "n1",
                title: "Ada",
                folder_path: None,
                content: "",
                tags: &tags,
                properties: Some(&properties),
                emoji: None,
            },
            "device-a",
            NOW,
        )?;
        note_meta::metadata(conn, "n1")
    })
    .expect("the read")
    .expect("the note")
}

type Shape = Vec<(String, Option<String>, Vec<(String, String, String)>)>;

fn shape(meta: &note_meta::NoteMetadata) -> Shape {
    meta.tag_fields
        .iter()
        .map(|g| {
            let fields = g
                .fields
                .iter()
                .map(|f| {
                    (
                        f.property.name.clone(),
                        f.property.type_name.clone().unwrap_or_default(),
                        f.property.value_json.clone(),
                    )
                })
                .collect();
            (g.tag.clone(), g.via.clone(), fields)
        })
        .collect()
}

fn s(v: &str) -> String {
    v.to_owned()
}

#[test]
fn fields_group_per_tag_with_inherited_ones_via_the_child() {
    let db = open();
    define_property(&db, "Born", "date");
    define_tag(
        &db,
        "entity",
        json!({ "t": 1, "fields": [{ "name": "Born" }, { "name": "Role" }] }),
    );
    define_tag(
        &db,
        "person",
        json!({ "t": 2, "extends": "entity", "fields": [
            { "name": "Company", "relation": { "target": "Company", "many": false } },
            { "name": "Role" },
            { "name": "tags" }
        ]}),
    );
    let meta = note(
        &db,
        &["Person", "person", "plain"],
        json!({ "Role": "CTO", "Other": 1 }),
    );

    assert_eq!(
        shape(&meta),
        vec![
            (
                s("person"),
                None,
                vec![
                    (s("Company"), s("relation"), s("null")),
                    (s("Role"), s("text"), s("\"CTO\"")),
                ]
            ),
            (
                s("entity"),
                Some(s("person")),
                vec![(s("Born"), s("date"), s("null"))]
            ),
        ]
    );
    let company = &meta.tag_fields[0].fields[0];
    assert!(!company.has_value);
    assert_eq!(company.relation_target.as_deref(), Some("company"));
    assert!(meta.tag_fields[0].fields[1].has_value);
}

#[test]
fn a_schema_this_build_cannot_read_lists_no_fields() {
    let db = open();
    define_tag(
        &db,
        "book",
        json!({ "t": "newer", "fields": [{ "name": "Author" }] }),
    );
    define_tag(&db, "film", json!({ "t": 1, "fields": "newer" }));
    let meta = note(&db, &["book", "film"], json!({}));
    assert!(meta.tag_fields.is_empty());
}
