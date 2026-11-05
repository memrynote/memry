//! [`super::save`] against a real `data.db`: the edit lands in the definition's payload and its
//! outbox row, a no-op writes nothing, and a schema this build cannot read is left.

use serde_json::{Value, json};

use super::*;
use crate::domain::notes::failed;
use crate::storage::repositories::{InboundRecord, sync_items};
use crate::storage::{Db, open_data, test_support::temp_dir};

const NOW: i64 = 1_760_000_000_000;

fn field(name: &str) -> NewField {
    NewField {
        name: name.into(),
        relation: None,
    }
}

fn seeded(label: &str, payload: &str) -> (Db, crate::storage::test_support::TempDir) {
    let dir = temp_dir(label);
    let db = open_data(&dir.path().join("data.db")).expect("open");
    db.call_blocking(|conn| {
        sync_items::apply_remote(
            conn,
            &InboundRecord {
                item_type: "tag_definition".into(),
                item_id: "Person".into(),
                payload_json: payload.into(),
                server_cursor: Some(1),
                signer_device_id: Some("desk".into()),
                updated_at: NOW,
                deleted_at: None,
            },
            NOW,
        )?;
        Ok(())
    })
    .expect("seed");
    (db, dir)
}

fn stored_schema(db: &Db, id: &str) -> Value {
    db.call_blocking(|c| {
        let row = sync_items::load(c, "tag_definition", id)?.expect("definition");
        let payload: Value = serde_json::from_str(&row.payload.expect("payload")).expect("json");
        Ok(payload["schema"].clone())
    })
    .expect("schema")
}

fn pending(db: &Db, id: &str) -> i64 {
    db.call_blocking(|c| {
        c.query_row(
            "SELECT COUNT(*) FROM outbox WHERE item_type = 'tag_definition' AND item_id = ?1",
            [id],
            |r| r.get::<_, i64>(0),
        )
        .map_err(failed)
    })
    .expect("outbox")
}

#[test]
fn a_saved_edit_lands_in_the_definition_and_its_outbox_row_and_a_no_op_writes_nothing() {
    let (db, _dir) = seeded(
        "tag-schema-save",
        r#"{"name":"Person","color":"sky","clock":{"desk":1},"schema":{"t":2,"fields":[{"name":"Role"}],"later":true}}"#,
    );
    let save_edit = |tag: &str, edit: SchemaEdit| {
        db.call_blocking(|conn| {
            save(conn, tag, &edit, "me", NOW).map_err(|e| match e {
                SaveError::Storage(s) => s,
                SaveError::Edit(e) => panic!("refused: {e:?}"),
            })
        })
        .expect("save")
    };

    let noop = save_edit(
        "person",
        SchemaEdit::MoveField {
            name: "role".into(),
            to_index: 0,
        },
    );
    assert!(!noop.changed);
    assert_eq!(pending(&db, "Person"), 0);

    save_edit(
        "PERSON",
        SchemaEdit::AddField {
            field: field("Email"),
            index: None,
        },
    );
    assert_eq!(
        stored_schema(&db, "Person"),
        json!({"t": 3, "fields": [{"name": "Role"}, {"name": "Email"}], "later": true})
    );
    assert_eq!(pending(&db, "Person"), 1);

    save_edit(
        "Contact",
        SchemaEdit::AddField {
            field: field("Phone"),
            index: None,
        },
    );
    assert_eq!(
        stored_schema(&db, "contact"),
        json!({"t": 1, "fields": [{"name": "Phone"}], "template": null, "extends": null, "preset": null}),
        "a tag with no definition gets one under its key"
    );
}

#[test]
fn a_saved_edit_refuses_a_schema_it_cannot_read_and_leaves_it() {
    let (db, _dir) = seeded(
        "tag-schema-unreadable",
        r#"{"name":"Person","color":"sky","clock":{"desk":1},"schema":{"t":4,"fields":7}}"#,
    );
    let refused = db
        .call_blocking(|conn| {
            Ok(save(
                conn,
                "person",
                &SchemaEdit::SetTemplate { template: None },
                "me",
                NOW,
            ))
        })
        .expect("call");
    assert!(matches!(
        refused,
        Err(SaveError::Edit(SchemaEditError::UnreadableSchema))
    ));
    assert_eq!(stored_schema(&db, "Person"), json!({"t": 4, "fields": 7}));
    assert_eq!(pending(&db, "Person"), 0);
}
