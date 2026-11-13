//! The three desktop record types together (Step 16, #3533): one pulled page
//! of each lands whole, and a key this build does not model survives a local
//! edit (§13.2 rule 3).

use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, params};
use serde_json::{Value, json};

use super::testing::{DEVICE, NOW, iso, open, payload, pull, remote};
use crate::domain::canvas_folder;
use crate::domain::home_page::{self, HomePagePatch};
use crate::domain::sticky_draft::{self, StickyKind};
use crate::storage::repositories::sync_items;

const TYPES: [&str; 3] = ["canvas_folder", "home_page", "sticky_draft"];

/// A payload of `item_type` a peer could send for id `id`, as Electron pushes
/// it.
fn body(item_type: &str, id: &str) -> Value {
    match item_type {
        "canvas_folder" => json!({
            "id": id, "vaultId": "vault-1", "path": "Work", "icon": "star",
            "clock": {"peer": 1}, "deletedAt": null,
        }),
        "home_page" => json!({
            "id": id, "name": "Home", "icon": null, "position": 0, "widgets": "[]",
            "cover": {"ref": "unsplash:a"}, "clock": {"peer": 1},
            "createdAt": iso(NOW), "updatedAt": iso(NOW), "syncedAt": iso(NOW),
        }),
        _ => json!({
            "id": id, "content": "hi", "kind": "note", "clock": {"peer": 1},
            "createdAt": iso(NOW), "modifiedAt": iso(NOW), "syncedAt": iso(NOW),
        }),
    }
}

fn id_of(item_type: &str) -> String {
    match item_type {
        "canvas_folder" => canvas_folder::sync_id("Work"),
        _ => format!("{item_type}-1"),
    }
}

fn count(conn: &Connection, sql: &str) -> i64 {
    conn.query_row(sql, params![], |row| row.get(0))
        .expect("count")
}

/// A local edit of the record, through the type's own write.
fn edit(conn: &Connection, item_type: &str, id: &str) {
    match item_type {
        "canvas_folder" => canvas_folder::upsert(
            conn,
            "vault-1",
            "Work",
            Some(Some("moon")),
            DEVICE,
            NOW + 20,
        )
        .map(drop),
        "home_page" => home_page::update(
            conn,
            id,
            &HomePagePatch {
                name: Some("Edited"),
                ..HomePagePatch::default()
            },
            DEVICE,
            NOW + 20,
        )
        .map(drop),
        _ => sticky_draft::upsert(conn, Some(id), "edited", StickyKind::Note, DEVICE, NOW + 20)
            .map(drop),
    }
    .expect("a local edit");
}

/// A `??` key keeps the local value only when the remote leaves it out, so a
/// `null` for it must be refused first ([`super::apply_kept`]).
#[test]
fn every_coalesce_key_is_refused_as_null() {
    for kept in [
        &canvas_folder::merge::KEPT,
        &home_page::merge::KEPT,
        &sticky_draft::merge::KEPT,
    ] {
        for key in kept.coalesce {
            assert!(kept.not_null.contains(key), "{key}");
        }
    }
}

/// Chapter 13 §13.7.23-25: a tick written as anything but a JSON integer
/// literal is refused, though desktop's `z.int()` takes `1.0` and `1e0`.
#[test]
fn a_tick_not_written_as_an_integer_literal_is_refused() {
    let object = |text: &str| -> crate::storage::repositories::schema::Object {
        serde_json::from_str(text).expect("an object")
    };
    for tick in ["1.0", "-0", "1e0"] {
        let remote = object(&format!(r#"{{"clock": {{"peer": {tick}}}}}"#));
        assert!(
            super::fails_desktop_schema("sticky_draft", &remote, &[]),
            "{tick}"
        );
    }
    assert!(!super::fails_desktop_schema(
        "sticky_draft",
        &object(r#"{"clock": {"peer": 1}}"#),
        &[]
    ));
}

#[test]
fn one_page_of_each_type_lands_whole() {
    let (db, _dir) = open("desktop-records-pull");
    db.call_blocking(|conn| {
        let items = TYPES
            .iter()
            .map(|item_type| {
                remote(
                    item_type,
                    &id_of(item_type),
                    &body(item_type, &id_of(item_type)),
                )
            })
            .collect();
        let totals = pull(conn, items)?;
        assert_eq!((totals.applied, totals.corrupt, totals.skipped), (3, 0, 0));
        assert_eq!(
            count(
                conn,
                "SELECT COUNT(*) FROM sync_items
                 WHERE item_type IN ('canvas_folder', 'home_page', 'sticky_draft')"
            ),
            3
        );
        for table in ["canvas_folders", "home_pages", "sticky_drafts"] {
            assert_eq!(
                count(conn, &format!("SELECT COUNT(*) FROM {table}")),
                1,
                "{table}"
            );
        }
        for item_type in TYPES {
            let id = id_of(item_type);
            assert_eq!(
                sync_items::push_payload(conn, item_type, &id)?,
                Some(body(item_type, &id).to_string()),
                "{item_type} verbatim"
            );
        }
        Ok(())
    })
    .expect("pull");
}

/// Everything a refused remote must leave alone: the stored row (payload,
/// clock, tombstone, corrupt mark) and the projected row.
fn snapshot(conn: &Connection, item_type: &str, id: &str) -> (String, Vec<SqlValue>) {
    let row = sync_items::load(conn, item_type, id)
        .expect("read")
        .expect("a row");
    let stored = format!(
        "{:?}",
        (
            &row.payload,
            &row.clock,
            row.deleted_at,
            &row.corrupt_reason
        )
    );
    let table = match item_type {
        "canvas_folder" => "canvas_folders",
        "home_page" => "home_pages",
        _ => "sticky_drafts",
    };
    let projected = conn
        .query_row(
            &format!("SELECT * FROM {table} WHERE id = ?1"),
            params![id],
            |row| {
                (0..row.as_ref().column_count())
                    .map(|index| row.get::<_, SqlValue>(index))
                    .collect()
            },
        )
        .expect("a projected row");
    (stored, projected)
}

/// A remote whose schema keys desktop's schema refuses
/// (`packages/contracts/src/sync-payloads.ts`), which `apply-item.ts:166-176`
/// turns into `schema_invalid` before the handler reads the local row.
fn refused_cases() -> Vec<(&'static str, Value)> {
    vec![
        ("canvas_folder", json!({"path": 5})),
        ("canvas_folder", json!({"icon": 5})),
        ("canvas_folder", json!({"deletedAt": "x"})),
        ("canvas_folder", json!({"id": null})),
        ("canvas_folder", json!({"vaultId": null, "deletedAt": 123})),
        ("canvas_folder", json!({"clock": "x"})),
        ("canvas_folder", json!({"clock": {"peer": 3, DEVICE: -1}})),
        ("home_page", json!({"clock": {"peer": 3, DEVICE: 2.5}})),
        (
            "sticky_draft",
            json!({"clock": {"peer": 9_007_199_254_740_992_u64, DEVICE: 2}}),
        ),
        ("home_page", json!({"name": 5})),
        ("home_page", json!({"position": "x"})),
        ("home_page", json!({"icon": 5})),
        ("home_page", json!({"createdAt": null})),
        ("home_page", json!({"updatedAt": null})),
        ("home_page", json!({"updatedAt": 5})),
        ("sticky_draft", json!({"content": 5})),
        ("sticky_draft", json!({"kind": 5})),
        ("sticky_draft", json!({"createdAt": null})),
        ("sticky_draft", json!({"modifiedAt": null})),
        ("sticky_draft", json!({"modifiedAt": 5})),
    ]
}

/// A body that dominates a local record pulled from [`body`] and edited once.
fn dominating(item_type: &str, id: &str, bad: &Value) -> Value {
    let mut sent = body(item_type, id);
    let object = sent.as_object_mut().expect("object");
    object.insert("clock".to_owned(), json!({"peer": 2, DEVICE: 2}));
    if item_type == "canvas_folder" {
        object.insert("deletedAt".to_owned(), json!(NOW + 30));
    }
    for (key, value) in bad.as_object().expect("object") {
        object.insert(key.clone(), value.clone());
    }
    sent
}

#[test]
fn a_dominating_remote_desktop_refuses_leaves_the_local_record_alone() {
    let mut failures = Vec::new();
    for (item_type, bad) in refused_cases() {
        let case = format!("{item_type} {bad}");
        let (db, _dir) = open("desktop-records-refuse");
        let outcome = db.call_blocking(move |conn| {
            let id = id_of(item_type);
            pull(conn, vec![remote(item_type, &id, &body(item_type, &id))])?;
            edit(conn, item_type, &id);
            let before = snapshot(conn, item_type, &id);

            let totals = pull(
                conn,
                vec![remote(item_type, &id, &dominating(item_type, &id, &bad))],
            )?;

            let counts = (totals.applied, totals.corrupt, totals.skipped);
            let after = snapshot(conn, item_type, &id);
            Ok((counts == (0, 0, 1) && after == before)
                .then_some(())
                .ok_or(format!("{counts:?}, {after:?}")))
        });
        match outcome {
            Ok(Ok(())) => {}
            Ok(Err(what)) => failures.push(format!("{case}: {what}")),
            Err(error) => failures.push(format!("{case}: {error}")),
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// The control for the test above: the same remote without the refused key
/// wins, so each refusal is the schema check and not the clock gate.
#[test]
fn the_same_dominating_remote_without_the_refused_key_applies() {
    for item_type in TYPES {
        let (db, _dir) = open("desktop-records-dominate");
        db.call_blocking(move |conn| {
            let id = id_of(item_type);
            pull(conn, vec![remote(item_type, &id, &body(item_type, &id))])?;
            edit(conn, item_type, &id);
            let before = snapshot(conn, item_type, &id);

            let sent = dominating(item_type, &id, &json!({}));
            let totals = pull(conn, vec![remote(item_type, &id, &sent)])?;

            assert_eq!(totals.applied, 1, "{item_type}");
            assert_ne!(snapshot(conn, item_type, &id), before, "{item_type}");
            Ok(())
        })
        .expect("pull");
    }
}

/// What desktop's schema accepts still lands over the local record: a float
/// number, an unreadable `cover` (`.catch(undefined)`), and a `null` for a key
/// the schema does not model.
#[test]
fn a_dominating_remote_desktop_accepts_applies() {
    let accepted = [
        ("canvas_folder", json!({"deletedAt": 1.5})),
        ("home_page", json!({"position": 1.5})),
        ("home_page", json!({"cover": 5})),
        ("home_page", json!({"id": null})),
        ("sticky_draft", json!({"id": null})),
    ];
    for (item_type, extra) in accepted {
        let (db, _dir) = open("desktop-records-accept");
        db.call_blocking(move |conn| {
            let id = id_of(item_type);
            pull(conn, vec![remote(item_type, &id, &body(item_type, &id))])?;
            edit(conn, item_type, &id);

            let sent = dominating(item_type, &id, &extra);
            let totals = pull(conn, vec![remote(item_type, &id, &sent)])?;

            assert_eq!(
                (totals.applied, totals.corrupt, totals.skipped),
                (1, 0, 0),
                "{item_type} {extra}"
            );
            let row = sync_items::load(conn, item_type, &id)?.expect("a row");
            assert_eq!(row.corrupt_reason, None, "{item_type} {extra}");
            Ok(())
        })
        .expect("pull");
    }
}

/// A create whose `clock` is `null` fails desktop's schema like any other
/// `null` the schema has no room for.
#[test]
fn a_create_with_a_null_clock_is_refused() {
    for item_type in TYPES {
        let (db, _dir) = open("desktop-records-null-clock");
        db.call_blocking(move |conn| {
            let id = id_of(item_type);
            let mut sent = body(item_type, &id);
            sent["clock"] = Value::Null;
            let totals = pull(conn, vec![remote(item_type, &id, &sent)])?;

            assert_eq!(
                (totals.applied, totals.corrupt, totals.skipped),
                (0, 0, 1),
                "{item_type}"
            );
            assert!(
                sync_items::load(conn, item_type, &id)?.is_none(),
                "{item_type}"
            );
            Ok(())
        })
        .expect("pull");
    }
}

/// A live remote that is not a JSON object leaves a local record alone, and
/// with none it is stored as corrupt, as before.
#[test]
fn a_remote_that_is_not_an_object_leaves_the_local_record_alone() {
    for item_type in TYPES {
        for sent in [json!([]), json!(5), Value::Null] {
            let (db, _dir) = open("desktop-records-not-object");
            db.call_blocking(move |conn| {
                let id = id_of(item_type);
                pull(conn, vec![remote(item_type, &id, &body(item_type, &id))])?;
                edit(conn, item_type, &id);
                let before = snapshot(conn, item_type, &id);

                let totals = pull(conn, vec![remote(item_type, &id, &sent)])?;

                assert_eq!(
                    (totals.applied, totals.corrupt, totals.skipped),
                    (0, 0, 1),
                    "{item_type} {sent}"
                );
                assert_eq!(snapshot(conn, item_type, &id), before, "{item_type} {sent}");

                let fresh = format!("{id}-fresh");
                let totals = pull(conn, vec![remote(item_type, &fresh, &sent)])?;
                assert_eq!(totals.corrupt, 1, "{item_type} {sent} with no local row");
                Ok(())
            })
            .expect("pull");
        }
    }
}

mod properties {
    use super::*;
    use memry_test_kit::proptest_config;
    use proptest::prelude::*;

    /// Each case migrates a fresh `data.db` (about 50 ms), so the default 2000
    /// would take minutes.
    const CASES: u32 = 128;

    fn unknown_value() -> impl Strategy<Value = Value> {
        let leaf = prop_oneof![
            Just(Value::Null),
            any::<bool>().prop_map(Value::from),
            any::<i32>().prop_map(Value::from),
            "[a-z ]{0,8}".prop_map(Value::from),
        ];
        leaf.prop_recursive(3, 12, 3, |inner| {
            prop_oneof![
                prop::collection::vec(inner.clone(), 0..3).prop_map(Value::from),
                prop::collection::btree_map("[a-z]{1,3}", inner, 0..3)
                    .prop_map(|map| Value::Object(map.into_iter().collect())),
            ]
        })
    }

    proptest! {
        #![proptest_config(proptest_config(CASES))]

        #[test]
        fn a_key_this_build_does_not_model_survives_a_local_edit(
            item_type in prop::sample::select(TYPES.to_vec()),
            key in "x[A-Za-z]{1,8}",
            value in unknown_value(),
        ) {
            let (db, _dir) = open("desktop-records-preserve");
            let id = id_of(item_type);
            let mut sent = body(item_type, &id);
            sent.as_object_mut().expect("object").insert(key.clone(), value.clone());
            let pushed = db.call_blocking(move |conn| {
                let totals = pull(conn, vec![remote(item_type, &id, &sent)])?;
                assert_eq!(totals.applied, 1);
                edit(conn, item_type, &id);
                Ok(payload(conn, item_type, &id))
            }).expect("apply then edit");
            prop_assert_eq!(pushed.get(&key), Some(&value), "{} lost {}", item_type, key);
        }
    }
}
