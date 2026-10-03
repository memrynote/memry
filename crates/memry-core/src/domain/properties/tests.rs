use super::*;
use crate::storage::repositories::{InboundRecord, sync_items};
use crate::storage::{Db, open_data, test_support::temp_dir};
use serde_json::json;

const NOW: i64 = 1_760_000_000_000;
const DEVICE: &str = "device-b";

const NOTE: &str = concat!(
    r#"{"title":"A note","properties":{"area":"Work","effort":3},"#,
    r#""clock":{"device-a":2},"coverImage":{"url":"memry://cover/1"}}"#
);

fn seed(db: &Db, item_type: &str, item_id: &str, payload_json: &str) {
    db.call_blocking(|conn| {
        let record = InboundRecord {
            item_type: item_type.to_owned(),
            item_id: item_id.to_owned(),
            payload_json: payload_json.to_owned(),
            server_cursor: Some(7),
            signer_device_id: Some("device-a".to_owned()),
            updated_at: NOW,
            deleted_at: None,
        };
        sync_items::apply_remote(conn, &record, NOW)?;
        Ok(())
    })
    .expect("seed");
}

fn open(label: &str, payload_json: &str) -> (Db, crate::storage::test_support::TempDir) {
    let dir = temp_dir(label);
    let db = open_data(&dir.path().join("data.db")).expect("open data.db");
    seed(&db, "note", "note-1", payload_json);
    (db, dir)
}

fn pushed(conn: &Connection) -> Value {
    let raw = sync_items::push_payload(conn, "note", "note-1")
        .expect("push payload")
        .expect("a payload");
    serde_json::from_str(&raw).expect("valid JSON")
}

#[test]
fn a_value_edit_keeps_the_type_and_the_unmodelled_key() {
    let (db, _dir) = open("props-set", NOTE);
    db.call_blocking(|conn| {
        let values = set(
            conn,
            "note",
            "note-1",
            "area",
            json!("Home"),
            DEVICE,
            NOW + 1,
        )
        .expect("set");
        assert_eq!(values["area"], json!("Home"));
        assert_eq!(values["effort"], json!(3));

        let payload = pushed(conn);
        assert_eq!(payload["properties"], json!({"area":"Home","effort":3}));
        assert_eq!(payload["coverImage"], json!({"url": "memry://cover/1"}));
        assert_eq!(payload["clock"], json!({"device-a": 2, "device-b": 1}));

        let projected: String = conn
            .query_row(
                "SELECT properties FROM notes WHERE id = 'note-1'",
                [],
                |r| r.get(0),
            )
            .expect("projection");
        assert_eq!(projected, r#"{"area":"Home","effort":3}"#);
        Ok(())
    })
    .expect("set");
}

#[test]
fn an_edit_that_would_retype_a_value_is_refused_and_writes_nothing() {
    let (db, _dir) = open("props-retype", NOTE);
    db.call_blocking(|conn| {
        let refused = set(
            conn,
            "note",
            "note-1",
            "effort",
            json!("3"),
            DEVICE,
            NOW + 1,
        );
        assert_eq!(
            refused,
            Err(PropertyError::Retyped {
                name: "effort".to_owned(),
                existing: "a number",
                proposed: "text",
            })
        );

        // Nothing merged, nothing queued.
        let raw = sync_items::push_payload(conn, "note", "note-1")?.expect("a payload");
        assert_eq!(raw, NOTE);
        let queued: i64 = conn
            .query_row("SELECT COUNT(*) FROM outbox", [], |row| row.get(0))
            .expect("outbox");
        assert_eq!(queued, 0);
        Ok(())
    })
    .expect("retype");
}

#[test]
fn a_fraction_is_not_a_retype_of_an_integer() {
    let (db, _dir) = open("props-fraction", NOTE);
    db.call_blocking(|conn| {
        let values = set(
            conn,
            "note",
            "note-1",
            "effort",
            json!(3.5),
            DEVICE,
            NOW + 1,
        )
        .expect("set");
        assert_eq!(values["effort"], json!(3.5));
        Ok(())
    })
    .expect("fraction");
}

#[test]
fn a_clear_is_always_allowed_and_the_next_write_sets_the_type_afresh() {
    let (db, _dir) = open("props-clear", NOTE);
    db.call_blocking(|conn| {
        let values = clear(conn, "note", "note-1", "effort", DEVICE, NOW + 1).expect("clear");
        assert_eq!(values["effort"], Value::Null);
        assert!(
            values.contains_key("effort"),
            "§13.4: a clear leaves the key present and null"
        );

        // A cleared property claims no type, so any value may follow it.
        let values = set(
            conn,
            "note",
            "note-1",
            "effort",
            json!("large"),
            DEVICE,
            NOW + 2,
        )
        .expect("set after clear");
        assert_eq!(values["effort"], json!("large"));
        Ok(())
    })
    .expect("clear");
}

#[test]
fn removing_a_property_drops_the_key_rather_than_nulling_it() {
    let (db, _dir) = open("props-remove", NOTE);
    db.call_blocking(|conn| {
        let values = remove(conn, "note", "note-1", "effort", DEVICE, NOW + 1)?;
        assert!(!values.contains_key("effort"));
        assert_eq!(pushed(conn)["properties"], json!({"area":"Work"}));

        // Removing what is not there writes nothing.
        remove(conn, "note", "note-1", "effort", DEVICE, NOW + 2)?;
        let queued: i64 = conn
            .query_row("SELECT COUNT(*) FROM outbox", [], |row| row.get(0))
            .expect("outbox");
        assert_eq!(queued, 1);
        Ok(())
    })
    .expect("remove");
}

#[test]
fn renaming_moves_the_value_and_drops_the_old_key() {
    let (db, _dir) = open("props-rename", NOTE);
    db.call_blocking(|conn| {
        let values = rename(conn, "note", "note-1", "effort", "Effort", DEVICE, NOW + 1)?;
        assert!(
            !values.contains_key("effort"),
            "the old key is dropped, not nulled"
        );
        assert_eq!(values["Effort"], json!(3));
        let payload = pushed(conn);
        assert_eq!(payload["properties"], json!({"area":"Work","Effort":3}));
        assert_eq!(
            payload["properties"]
                .as_object()
                .expect("object")
                .keys()
                .collect::<Vec<_>>(),
            vec!["area", "Effort"],
            "a rename keeps the property's place"
        );
        assert_eq!(payload["coverImage"], json!({"url": "memry://cover/1"}));
        Ok(())
    })
    .expect("rename");
}

#[test]
fn a_rename_onto_an_existing_name_or_from_a_missing_one_is_refused() {
    let (db, _dir) = open("props-rename-refused", NOTE);
    db.call_blocking(|conn| {
        assert!(matches!(
            rename(conn, "note", "note-1", "effort", "area", DEVICE, NOW + 1),
            Err(StorageError::Invalid { .. })
        ));
        assert!(matches!(
            rename(conn, "note", "note-1", "missing", "x", DEVICE, NOW + 1),
            Err(StorageError::NotFound { .. })
        ));
        assert!(matches!(
            rename(conn, "note", "note-1", "effort", "  ", DEVICE, NOW + 1),
            Err(StorageError::Invalid { .. })
        ));
        // Same name: nothing written.
        rename(conn, "note", "note-1", "effort", "effort", DEVICE, NOW + 1)?;
        let raw = sync_items::push_payload(conn, "note", "note-1")?.expect("a payload");
        assert_eq!(raw, NOTE);
        let queued: i64 = conn
            .query_row("SELECT COUNT(*) FROM outbox", [], |row| row.get(0))
            .expect("outbox");
        assert_eq!(queued, 0);
        Ok(())
    })
    .expect("refused");
}

fn pushed_order(conn: &Connection) -> Vec<String> {
    pushed(conn)["properties"]
        .as_object()
        .expect("properties")
        .keys()
        .cloned()
        .collect()
}

fn queued(conn: &Connection) -> i64 {
    conn.query_row("SELECT COUNT(*) FROM outbox", [], |row| row.get(0))
        .expect("outbox")
}

#[test]
fn the_payload_key_order_is_the_property_order_and_survives_edits() {
    let (db, _dir) = open(
        "props-order",
        r#"{"title":"t","properties":{"zeta":1,"alpha":"a","mid":true},"clock":{"device-a":1}}"#,
    );
    db.call_blocking(|conn| {
        let order: Vec<String> = values(conn, "note", "note-1")?.keys().cloned().collect();
        assert_eq!(
            order,
            vec!["zeta", "alpha", "mid"],
            "desktop's order is read as stored"
        );

        set(conn, "note", "note-1", "alpha", json!("b"), DEVICE, NOW + 1).expect("set");
        assert_eq!(pushed_order(conn), vec!["zeta", "alpha", "mid"]);

        remove(conn, "note", "note-1", "zeta", DEVICE, NOW + 2)?;
        assert_eq!(pushed_order(conn), vec!["alpha", "mid"]);
        Ok(())
    })
    .expect("order");
}

#[test]
fn a_reorder_puts_the_named_properties_first_and_keeps_the_rest() {
    let (db, _dir) = open(
        "props-reorder",
        r#"{"title":"t","properties":{"a":1,"b":2,"c":3,"d":4},"clock":{"device-a":1}}"#,
    );
    db.call_blocking(|conn| {
        let names = |list: &[&str]| list.iter().map(|it| (*it).to_owned()).collect::<Vec<_>>();

        // Same order: nothing written.
        reorder(conn, "note", "note-1", &names(&["a", "b"]), DEVICE, NOW + 1)?;
        assert_eq!(queued(conn), 0);

        let values = reorder(
            conn,
            "note",
            "note-1",
            &names(&["c", "ghost", "a"]),
            DEVICE,
            NOW + 2,
        )?;
        assert_eq!(values.keys().collect::<Vec<_>>(), vec!["c", "a", "b", "d"]);
        assert_eq!(pushed_order(conn), vec!["c", "a", "b", "d"]);
        assert_eq!(pushed(conn)["clock"], json!({"device-a": 1, "device-b": 1}));
        assert_eq!(queued(conn), 1);
        Ok(())
    })
    .expect("reorder");
}

#[test]
fn a_value_edit_never_writes_a_property_definition() {
    let (db, _dir) = open("props-definition", NOTE);
    seed(
        &db,
        "property_definition",
        "effort",
        r#"{"name":"effort","type":"number","clock":{"device-a":1}}"#,
    );
    db.call_blocking(|conn| {
        let before = definition(conn, "effort")?.expect("the definition");
        set(conn, "note", "note-1", "effort", json!(8), DEVICE, NOW + 1).expect("set");
        assert_eq!(definition(conn, "effort")?.as_ref(), Some(&before));

        let queued: Vec<String> = {
            let mut statement = conn.prepare("SELECT item_type FROM outbox").expect("prep");
            let mapped = statement
                .query_map([], |row| row.get::<_, String>(0))
                .expect("query");
            mapped.map(|row| row.expect("row")).collect()
        };
        assert_eq!(queued, vec!["note".to_owned()]);
        Ok(())
    })
    .expect("definition");
}

#[test]
fn a_properties_value_that_will_not_read_is_an_error_and_never_an_empty_map() {
    let (db, _dir) = open("props-unreadable", r#"{"title":"t","properties":["area"]}"#);
    db.call_blocking(|conn| {
        assert!(values(conn, "note", "note-1").is_err());
        assert!(values(conn, "template", "tpl-1").is_err());
        Ok(())
    })
    .expect("unreadable");
}
