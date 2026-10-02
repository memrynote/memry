//! `canvas` against real SQLite, with the vectors of desktop's
//! `apps/desktop/src/main/sync/item-handlers/canvas-handler.test.ts`: its
//! `sceneWith`, `VAULT_ID`, `LOCAL_DEVICE` and clocks, so each test here
//! states the outcome desktop's test asserts for the same input.

use rusqlite::Connection;
use serde_json::{Value, json};

use super::{EMPTY_SCENE, ITEM_TYPE, NewCanvas, canonical_scene, create, get, set_scene};
use crate::storage::repositories::sync_items::{self, ApplyOutcome, InboundRecord};
use crate::storage::{Db, open_data, test_support::temp_dir};
use crate::sync::apply::{Pending, apply_inbound, apply_inbound_on, apply_page};
use crate::sync::clock::clock_of;

const VAULT_ID: &str = "vault-1";
const LOCAL_DEVICE: &str = "device-LOCAL";
const NOW: i64 = 1_760_000_000_000;

/// `sceneWith(entityId)` as desktop's `JSON.stringify` writes it.
fn scene_with(entity_id: &str) -> String {
    format!(
        r#"{{"type":"excalidraw","version":2,"source":"test","elements":[{{"id":"rect-{entity_id}","type":"rectangle","x":0,"y":0,"width":260,"height":168,"angle":0,"customData":{{"entityType":"note","entityId":"{entity_id}"}}}}],"appState":{{}},"files":{{}},"marker":""}}"#
    )
}

fn open(label: &str) -> (Db, crate::storage::test_support::TempDir) {
    let dir = temp_dir(label);
    let db = open_data(&dir.path().join("data.db")).expect("open data.db");
    (db, dir)
}

fn inbound(item_id: &str, payload: Value) -> InboundRecord {
    InboundRecord {
        item_type: ITEM_TYPE.to_owned(),
        item_id: item_id.to_owned(),
        payload_json: payload.to_string(),
        server_cursor: Some(7),
        signer_device_id: Some("device-desktop".to_owned()),
        updated_at: NOW,
        deleted_at: None,
    }
}

/// `seedCanvas(db, id, scene, clock, opts)`: the local row, as a pull leaves it.
fn seed(conn: &Connection, id: &str, scene: &str, clock: Value, extra: Value) {
    let mut payload = json!({
        "id": id, "vaultId": VAULT_ID, "title": "My Canvas", "scene": scene,
        "folder": null, "icon": null, "ownerNoteId": null, "clock": clock, "deletedAt": null,
    });
    for (key, value) in extra.as_object().expect("extra keys") {
        payload[key] = value.clone();
    }
    assert_eq!(
        apply_inbound(conn, &inbound(id, payload), NOW).expect("seed"),
        ApplyOutcome::Applied
    );
}

fn stored(conn: &Connection, id: &str) -> Value {
    let raw = sync_items::push_payload(conn, ITEM_TYPE, id)
        .expect("read")
        .expect("a payload");
    serde_json::from_str(&raw).expect("JSON")
}

fn canvas_ids(conn: &Connection) -> Vec<String> {
    let mut statement = conn
        .prepare("SELECT item_id FROM sync_items WHERE item_type = 'canvas' ORDER BY item_id")
        .expect("prepare");
    statement
        .query_map([], |row| row.get(0))
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("rows")
}

fn outbox(conn: &Connection) -> Vec<(String, String, String)> {
    let mut statement = conn
        .prepare("SELECT item_type, item_id, op FROM outbox ORDER BY id")
        .expect("prepare");
    statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("rows")
}

#[test]
fn a_remote_create_is_stored_verbatim_and_reads_back() {
    let (db, _dir) = open("canvas-create");
    db.call_blocking(|conn| {
        let record = inbound(
            "c1",
            json!({ "id": "c1", "vaultId": VAULT_ID, "title": "Remote",
                    "scene": scene_with("note-1"), "ownerNoteId": "note-9", "clock": { "B": 1 } }),
        );
        assert_eq!(apply_inbound(conn, &record, NOW)?, ApplyOutcome::Applied);
        assert_eq!(
            sync_items::push_payload(conn, ITEM_TYPE, "c1")?,
            Some(record.payload_json.clone())
        );
        let canvas = get(conn, "c1")?.expect("a live canvas");
        assert_eq!(canvas.title.as_deref(), Some("Remote"));
        assert_eq!(canvas.owner_note_id.as_deref(), Some("note-9"));
        assert_eq!(canvas.scene, scene_with("note-1"));
        Ok(())
    })
    .expect("create");
}

#[test]
fn a_payload_without_a_scene_or_a_create_without_a_vault_is_skipped() {
    let (db, _dir) = open("canvas-d5");
    db.call_blocking(|conn| {
        seed(
            conn,
            "c1",
            &scene_with("note-keep"),
            json!({ "A": 1 }),
            json!({}),
        );
        let no_scene = inbound(
            "c1",
            json!({ "id": "c1", "vaultId": VAULT_ID, "clock": { "A": 1, "B": 5 } }),
        );
        assert_eq!(apply_inbound(conn, &no_scene, NOW)?, ApplyOutcome::Skipped);
        assert_eq!(stored(conn, "c1")["scene"], json!(scene_with("note-keep")));

        let no_vault = inbound(
            "c2",
            json!({ "id": "c2", "scene": scene_with("note-1"), "clock": { "B": 1 } }),
        );
        assert_eq!(apply_inbound(conn, &no_vault, NOW)?, ApplyOutcome::Skipped);
        assert_eq!(get(conn, "c2")?, None);
        Ok(())
    })
    .expect("skips");
}

#[test]
fn a_newer_remote_overwrites_and_an_older_one_is_skipped() {
    let (db, _dir) = open("canvas-lww");
    db.call_blocking(|conn| {
        seed(
            conn,
            "c1",
            &scene_with("note-old"),
            json!({ "A": 1 }),
            json!({}),
        );
        let newer = inbound(
            "c1",
            json!({ "id": "c1", "vaultId": VAULT_ID, "scene": scene_with("note-new"),
                    "clock": { "A": 1, "B": 2 } }),
        );
        assert_eq!(apply_inbound(conn, &newer, NOW)?, ApplyOutcome::Applied);
        let row = stored(conn, "c1");
        assert_eq!(row["clock"], json!({ "A": 1, "B": 2 }));
        assert_eq!(row["scene"], json!(scene_with("note-new")));
        assert_eq!(row["title"], json!("My Canvas"));

        seed(
            conn,
            "c2",
            &scene_with("note-keep"),
            json!({ "A": 5 }),
            json!({}),
        );
        let older = inbound(
            "c2",
            json!({ "id": "c2", "vaultId": VAULT_ID, "scene": scene_with("note-remote"),
                    "clock": { "A": 2 } }),
        );
        assert_eq!(apply_inbound(conn, &older, NOW)?, ApplyOutcome::Skipped);
        assert_eq!(stored(conn, "c2")["scene"], json!(scene_with("note-keep")));
        Ok(())
    })
    .expect("lww");
}

#[test]
fn an_absent_owner_keeps_ours_null_clears_it_and_a_note_id_replaces_it() {
    let (db, _dir) = open("canvas-owner");
    db.call_blocking(|conn| {
        for (id, stated, expected) in [
            ("c1", json!({}), json!("note-1")),
            ("c2", json!({ "ownerNoteId": null }), Value::Null),
            ("c3", json!({ "ownerNoteId": "note-2" }), json!("note-2")),
        ] {
            seed(
                conn,
                id,
                &scene_with("note-old"),
                json!({ "A": 1 }),
                json!({ "ownerNoteId": "note-1" }),
            );
            let mut payload = json!({ "id": id, "vaultId": VAULT_ID,
                "scene": scene_with("note-new"), "clock": { "A": 1, "B": 2 } });
            for (key, value) in stated.as_object().expect("keys") {
                payload[key] = value.clone();
            }
            assert_eq!(
                apply_inbound(conn, &inbound(id, payload), NOW)?,
                ApplyOutcome::Applied
            );
            assert_eq!(stored(conn, id)["ownerNoteId"], expected, "{id}");
        }
        Ok(())
    })
    .expect("owner");
}

#[test]
fn an_update_that_clears_the_title_propagates_the_clear() {
    let (db, _dir) = open("canvas-title-clear");
    db.call_blocking(|conn| {
        seed(
            conn,
            "c1",
            &scene_with("note-1"),
            json!({ "A": 1 }),
            json!({ "title": "Old" }),
        );
        let clear = inbound(
            "c1",
            json!({ "id": "c1", "vaultId": VAULT_ID, "title": null,
                    "scene": scene_with("note-2"), "clock": { "A": 1, "B": 2 } }),
        );
        assert_eq!(apply_inbound(conn, &clear, NOW)?, ApplyOutcome::Applied);
        assert_eq!(get(conn, "c1")?.expect("live").title, None);
        Ok(())
    })
    .expect("title");
}

#[test]
fn a_concurrent_edit_over_a_different_scene_keeps_both_drawings() {
    let (db, _dir) = open("canvas-conflict");
    db.call_blocking(|conn| {
        seed(
            conn,
            "c1",
            &scene_with("note-local"),
            json!({ "A": 2 }),
            json!({ "ownerNoteId": "note-1" }),
        );
        let remote = inbound(
            "c1",
            json!({ "id": "c1", "vaultId": VAULT_ID, "scene": scene_with("note-remote"),
                    "clock": { "B": 3 } }),
        );
        assert_eq!(
            apply_inbound_on(conn, &remote, NOW, Some(LOCAL_DEVICE))?,
            ApplyOutcome::Applied
        );

        let ids = canvas_ids(conn);
        assert_eq!(ids.len(), 2);
        let original = stored(conn, "c1");
        assert_eq!(original["clock"], json!({ "A": 2, "B": 3 }));
        assert_eq!(original["scene"], json!(scene_with("note-remote")));
        assert_eq!(original["ownerNoteId"], json!("note-1"));

        let copy_id = ids.iter().find(|id| *id != "c1").expect("a copy");
        assert_eq!(copy_id.len(), 21);
        assert_eq!(
            stored(conn, copy_id),
            json!({
                "id": copy_id, "vaultId": VAULT_ID, "title": "My Canvas (conflict copy)",
                "scene": scene_with("note-local"), "folder": null, "icon": null,
                "ownerNoteId": "note-1", "clock": { LOCAL_DEVICE: 1 }, "deletedAt": null,
            })
        );
        assert_eq!(
            outbox(conn),
            [(ITEM_TYPE.to_owned(), copy_id.clone(), "upsert".to_owned())]
        );
        Ok(())
    })
    .expect("conflict");
}

#[test]
fn a_concurrent_edit_over_an_identical_scene_merges_clocks_only() {
    let (db, _dir) = open("canvas-identical");
    db.call_blocking(|conn| {
        let scene = scene_with("note-same");
        seed(conn, "c1", &scene, json!({ "A": 2 }), json!({}));
        let remote = inbound(
            "c1",
            json!({ "id": "c1", "vaultId": VAULT_ID, "scene": scene, "clock": { "B": 3 } }),
        );
        assert_eq!(
            apply_inbound_on(conn, &remote, NOW, Some(LOCAL_DEVICE))?,
            ApplyOutcome::Applied
        );
        assert_eq!(canvas_ids(conn), ["c1"]);
        assert_eq!(outbox(conn), []);
        assert_eq!(stored(conn, "c1")["clock"], json!({ "A": 2, "B": 3 }));
        Ok(())
    })
    .expect("identical");
}

#[test]
fn a_divergence_with_no_device_clock_id_is_recorded_corrupt_and_loses_nothing() {
    let (db, _dir) = open("canvas-no-device");
    db.call_blocking(|conn| {
        seed(
            conn,
            "c1",
            &scene_with("note-local"),
            json!({ "A": 2 }),
            json!({}),
        );
        let remote = inbound(
            "c1",
            json!({ "id": "c1", "vaultId": VAULT_ID, "scene": scene_with("note-remote"),
                    "clock": { "B": 3 } }),
        );
        assert!(matches!(
            apply_inbound(conn, &remote, NOW)?,
            ApplyOutcome::Corrupt { .. }
        ));
        assert_eq!(canvas_ids(conn), ["c1"]);
        assert_eq!(stored(conn, "c1")["scene"], json!(scene_with("note-local")));
        Ok(())
    })
    .expect("no device");
}

#[test]
fn a_delete_beats_a_concurrent_edit_and_loses_to_a_later_one() {
    let (db, _dir) = open("canvas-delete");
    let delete = |id: &str, clock| Pending::Tombstone {
        item_type: ITEM_TYPE.to_owned(),
        item_id: id.to_owned(),
        deleted_at: NOW,
        server_cursor: None,
        clock: Some(clock),
    };
    db.call_blocking(|conn| {
        seed(
            conn,
            "c1",
            &scene_with("note-1"),
            json!({ "A": 2 }),
            json!({}),
        );
        let concurrent = apply_page(
            conn,
            vec![delete("c1", clock_of([("B", 1)]))],
            vec![],
            NOW,
            Some(LOCAL_DEVICE),
        )?;
        assert_eq!(concurrent.deleted, 1);
        assert_eq!(get(conn, "c1")?, None);

        seed(
            conn,
            "c2",
            &scene_with("note-1"),
            json!({ "A": 5 }),
            json!({}),
        );
        let older = apply_page(
            conn,
            vec![delete("c2", clock_of([("A", 2)]))],
            vec![],
            NOW,
            Some(LOCAL_DEVICE),
        )?;
        assert_eq!((older.deleted, older.skipped), (0, 1));
        assert!(get(conn, "c2")?.is_some());
        Ok(())
    })
    .expect("delete");
}

#[test]
fn a_local_create_writes_desktops_push_shape_and_queues_it() {
    let (db, _dir) = open("canvas-local-create");
    db.call_blocking(|conn| {
        let canvas = create(
            conn,
            &NewCanvas {
                title: Some("MB live board"),
                owner_note_id: Some("note-1"),
                scene: None,
            },
            VAULT_ID,
            LOCAL_DEVICE,
            NOW,
        )?
        .acknowledge();
        let raw = sync_items::push_payload(conn, ITEM_TYPE, &canvas.id)?.expect("a payload");
        assert_eq!(
            raw,
            format!(
                r#"{{"id":"{}","vaultId":"vault-1","title":"MB live board","scene":"{{\"type\":\"excalidraw\",\"version\":2,\"source\":\"memry\",\"elements\":[],\"appState\":{{}},\"files\":{{}}}}","folder":null,"icon":null,"ownerNoteId":"note-1","clock":{{"device-LOCAL":1}},"deletedAt":null}}"#,
                canvas.id
            )
        );
        assert_eq!(
            outbox(conn),
            [(ITEM_TYPE.to_owned(), canvas.id.clone(), "upsert".to_owned())]
        );
        Ok(())
    })
    .expect("local create");
}

#[test]
fn a_scene_edit_is_canonicalized_and_ticks_the_clock() {
    let (db, _dir) = open("canvas-set-scene");
    db.call_blocking(|conn| {
        seed(conn, "c1", &scene_with("note-1"), json!({ "B": 3 }), json!({}));
        let pretty = "{\n  \"elements\": [],\n  \"type\": \"excalidraw\",\n  \"memry\": {\"id\": \"c1\"}\n}";
        let canvas = set_scene(conn, "c1", pretty, LOCAL_DEVICE, NOW)?.acknowledge();
        assert_eq!(
            canvas.scene,
            r#"{"type":"excalidraw","version":2,"source":"memry","elements":[],"appState":{},"files":{}}"#
        );
        assert_eq!(
            stored(conn, "c1")["clock"],
            json!({ "B": 3, LOCAL_DEVICE: 1 })
        );
        assert_eq!(
            outbox(conn),
            [(ITEM_TYPE.to_owned(), "c1".to_owned(), "upsert".to_owned())]
        );
        Ok(())
    })
    .expect("set scene");
}

/// The 50 ms budget for one canvas apply: the costliest path (a diverged
/// concurrent edit, so a conflict copy plus the overwrite) on 500 elements.
/// `cargo test --release -p memry-core canvas_apply_timing -- --ignored --nocapture`.
#[test]
#[ignore = "perf probe, run by hand"]
fn canvas_apply_timing() {
    let scene = |tag: &str| {
        let elements: Vec<Value> = (0..500)
            .map(|i| {
                json!({ "id": format!("el-{tag}-{i}"), "type": "rectangle", "x": i * 10,
                        "y": i * 7, "width": 120.5, "height": 80.25, "angle": 0,
                        "strokeColor": "#1e1e1e", "seed": 1_000_000 + i, "version": 3 })
            })
            .collect();
        json!({ "type": "excalidraw", "version": 2, "source": "memry",
                "elements": elements, "appState": {}, "files": {} })
        .to_string()
    };
    let (local, remote) = (scene("local"), scene("remote"));
    for run in 0..10 {
        let (db, _dir) = open("canvas-perf");
        let millis = db
            .call_blocking(|conn| {
                seed(conn, "c1", &local, json!({ "A": 2 }), json!({}));
                let record = inbound(
                    "c1",
                    json!({ "id": "c1", "vaultId": VAULT_ID, "scene": remote, "clock": { "B": 3 } }),
                );
                let started = std::time::Instant::now();
                apply_inbound_on(conn, &record, NOW, Some(LOCAL_DEVICE))?;
                Ok(started.elapsed().as_secs_f64() * 1000.0)
            })
            .expect("timed apply");
        println!(
            "canvas_apply_ms\t{run}\t{millis:.3}\t{} bytes",
            remote.len()
        );
    }
}

#[test]
fn a_blank_scene_is_desktops_empty_board() {
    assert_eq!(canonical_scene("").expect("blank"), EMPTY_SCENE);
    assert_eq!(canonical_scene(" \n").expect("blank"), EMPTY_SCENE);
}

// `canonicalize` in apps/desktop/src/main/canvas/scene-file.ts, run on
// Excalidraw's own `serializeAsJSON` layout plus a file sidecar.
#[test]
fn a_scene_takes_desktops_canonical_text() {
    let pretty = r##"{
  "type": "excalidraw",
  "version": 2,
  "source": "https://excalidraw.com",
  "memry": { "id": "c1", "createdAt": 1, "updatedAt": 2 },
  "zeta": 1,
  "elements": [{ "id": "r1", "type": "rectangle", "x": 10.5, "y": 0 }],
  "appState": { "viewBackgroundColor": "#ffffff", "gridSize": null },
  "files": {},
  "memryAssets": []
}"##;
    assert_eq!(
        canonical_scene(pretty).expect("scene"),
        r##"{"type":"excalidraw","version":2,"source":"https://excalidraw.com","elements":[{"id":"r1","type":"rectangle","x":10.5,"y":0}],"appState":{"viewBackgroundColor":"#ffffff","gridSize":null},"files":{},"memryAssets":[],"zeta":1}"##
    );
}

#[test]
fn missing_or_null_head_keys_take_desktops_defaults() {
    assert_eq!(
        canonical_scene(r#"{"elements":null,"version":3}"#).expect("scene"),
        r#"{"type":"excalidraw","version":3,"source":"memry","elements":[],"appState":{},"files":{}}"#
    );
}

#[test]
fn text_that_is_not_a_json_object_is_refused() {
    assert!(canonical_scene("not json").is_err());
    assert!(canonical_scene("[1,2]").is_err());
}
