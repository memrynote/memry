//! A saved schema edit against what a pull brings (chapter 06 §6.11): the schema joins by its
//! own `t` on every apply branch, and a remote left behind is re-pushed (§6.11.4). Each case
//! saves one edit (t 3 to 4, adds "Email") over a definition a peer wrote, then applies one
//! inbound record.

use serde_json::{Value, json};

use super::*;
use crate::domain::notes::failed;
use crate::storage::repositories::{InboundRecord, sync_items};
use crate::storage::{Db, open_data, test_support::temp_dir};
use crate::sync::apply::apply_inbound_on;

const NOW: i64 = 1_760_000_000_000;
const PEER_SCHEMA: &str = r#"{"t":3,"fields":[{"name":"Role"}]}"#;

fn record(payload: Value) -> InboundRecord {
    InboundRecord {
        item_type: "tag_definition".into(),
        item_id: "Person".into(),
        payload_json: payload.to_string(),
        server_cursor: Some(2),
        signer_device_id: Some("desk".into()),
        updated_at: NOW,
        deleted_at: None,
    }
}

/// A definition the peer `desk` wrote at `{desk:1}`, with "Email" added here at t=4, and the
/// outbox emptied as if that edit was pushed.
fn edited(label: &str) -> (Db, crate::storage::test_support::TempDir) {
    let dir = temp_dir(label);
    let db = open_data(&dir.path().join("data.db")).expect("open");
    db.call_blocking(|conn| {
        let peer: Value = serde_json::from_str(&format!(
            r#"{{"name":"Person","color":"sky","clock":{{"desk":1}},"schema":{PEER_SCHEMA}}}"#
        ))
        .expect("json");
        sync_items::apply_remote(conn, &record(peer), NOW)?;
        let edit = SchemaEdit::AddField {
            field: NewField {
                name: "Email".into(),
                relation: None,
            },
            index: None,
        };
        save(conn, "person", &edit, "me", NOW).map_err(|error| match error {
            SaveError::Storage(error) => error,
            SaveError::Edit(error) => panic!("refused: {error:?}"),
        })?;
        conn.execute("DELETE FROM outbox", []).map_err(failed)?;
        Ok(())
    })
    .expect("seed");
    (db, dir)
}

fn apply(db: &Db, payload: Value) {
    db.call_blocking(|conn| apply_inbound_on(conn, &record(payload), NOW, Some("me")))
        .expect("apply");
}

fn stored(db: &Db) -> Value {
    db.call_blocking(|c| {
        let row = sync_items::load(c, "tag_definition", "Person")?.expect("definition");
        Ok(serde_json::from_str(&row.payload.expect("payload")).expect("json"))
    })
    .expect("stored")
}

fn pending(db: &Db) -> i64 {
    db.call_blocking(|c| {
        c.query_row(
            "SELECT COUNT(*) FROM outbox WHERE item_type = 'tag_definition'",
            [],
            |r| r.get::<_, i64>(0),
        )
        .map_err(failed)
    })
    .expect("outbox")
}

fn ours() -> Value {
    json!({"t": 4, "fields": [{"name": "Role"}, {"name": "Email"}]})
}

fn peer() -> Value {
    serde_json::from_str(PEER_SCHEMA).expect("json")
}

#[test]
fn a_concurrent_recolour_takes_the_colour_and_keeps_the_newer_schema_and_requeues() {
    let (db, _dir) = edited("tag-schema-sync-concurrent");
    apply(
        &db,
        json!({"name": "Person", "color": "rose", "clock": {"desk": 2}, "schema": peer()}),
    );

    let after = stored(&db);
    assert_eq!(after["color"], "rose");
    assert_eq!(after["schema"], ours());
    assert_eq!(
        after["clock"],
        json!({"desk": 2, "me": 1}),
        "the merge's requeue pushes the union, never ticked again (§6.5.2 P3)"
    );
    assert_eq!(
        pending(&db),
        1,
        "the requeue carries the kept schema, so no heal is owed (§6.11.4)"
    );
}

#[test]
fn a_stale_echo_under_a_newer_clock_keeps_the_newer_schema_and_heals() {
    let (db, _dir) = edited("tag-schema-sync-echo");
    apply(
        &db,
        json!({"name": "Person", "color": "sky", "clock": {"desk": 2, "me": 1}, "schema": peer()}),
    );

    assert_eq!(stored(&db)["schema"], ours());
    assert_eq!(pending(&db), 1);
}

#[test]
fn a_peer_that_omits_the_schema_keeps_it_and_heals() {
    let (db, _dir) = edited("tag-schema-sync-absent");
    apply(
        &db,
        json!({"name": "Person", "color": "sky", "clock": {"desk": 2, "me": 1}}),
    );

    assert_eq!(stored(&db)["schema"], ours());
    assert_eq!(pending(&db), 1);
}

#[test]
fn a_remote_null_schema_keeps_it_and_owes_no_heal() {
    let (db, _dir) = edited("tag-schema-sync-null");
    apply(
        &db,
        json!({"name": "Person", "color": "sky", "clock": {"desk": 2, "me": 1}, "schema": null}),
    );

    assert_eq!(stored(&db)["schema"], ours());
    assert_eq!(pending(&db), 0);
}

#[test]
fn a_skipped_record_still_brings_a_newer_schema_and_owes_no_heal() {
    let (db, _dir) = edited("tag-schema-sync-skip");
    let newer = json!({"t": 5, "fields": [{"name": "Phone"}]});
    apply(
        &db,
        json!({"name": "Person", "color": "sky", "clock": {"desk": 1}, "schema": newer}),
    );

    let after = stored(&db);
    assert_eq!(after["schema"], newer);
    assert_eq!(
        after["clock"],
        json!({"desk": 1, "me": 1}),
        "the skip keeps the local clock"
    );
    assert_eq!(pending(&db), 0);
}

#[test]
fn an_echo_of_our_own_push_changes_nothing_and_owes_no_heal() {
    let (db, _dir) = edited("tag-schema-sync-own-echo");
    let before = stored(&db);
    apply(
        &db,
        json!({"name": "Person", "color": "sky", "clock": {"desk": 1, "me": 1}, "schema": ours()}),
    );

    assert_eq!(stored(&db)["schema"], before["schema"]);
    assert_eq!(pending(&db), 0);
}
