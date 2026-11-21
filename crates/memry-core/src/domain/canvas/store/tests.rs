//! The canvas store against a real `data.db`: what each write leaves in
//! `sync_items`, the `canvases` projection and the outbox, and the sync cap
//! (`CANVAS_SCENE_SYNC_CAP_BYTES`, `apps/desktop/src/main/canvas/sync-bridge.ts:35-97`).

use rusqlite::{Connection, params};
use serde_json::{Value, json};

use super::super::{
    CANVAS_SCENE_SYNC_CAP_BYTES, CanvasEdit, EMPTY_SCENE, ITEM_TYPE, NewCanvas, SyncHold, Updated,
    canonical_scene, create, delete, duplicate, get, list, update,
};
use crate::api::errors::StorageError;
use crate::protocol::envelope::{NOTE_SYNC_MAX_BYTES, check_size};
use crate::storage::repositories::sync_items::{self, ApplyOutcome, InboundRecord};
use crate::storage::{Db, open_data, test_support::temp_dir};
use crate::sync::apply::{Pending, apply_inbound, apply_page};
use crate::sync::clock::clock_of;

const VAULT_ID: &str = "vault-1";
const DEVICE: &str = "device-LOCAL";
const NOW: i64 = 1_760_000_000_000;

fn open(label: &str) -> (Db, crate::storage::test_support::TempDir) {
    let dir = temp_dir(label);
    let db = open_data(&dir.path().join("data.db")).expect("open data.db");
    (db, dir)
}

/// A canonical scene exactly `len` bytes long: the empty board with a padded
/// top-level key, which canonicalization keeps as it is.
fn scene_of_len(len: usize) -> String {
    let head = &EMPTY_SCENE[..EMPTY_SCENE.len() - 1];
    let overhead = head.len() + r#","pad":""}"#.len();
    let scene = format!(r#"{head},"pad":"{}"}}"#, "x".repeat(len - overhead));
    assert_eq!(canonical_scene(&scene).expect("canonical").len(), len);
    scene
}

fn new_canvas<'a>(title: &'a str, scene: Option<&'a str>) -> NewCanvas<'a> {
    NewCanvas {
        title: Some(title),
        scene,
        ..NewCanvas::default()
    }
}

fn saved(updated: Updated) -> super::Saved {
    match updated {
        Updated::Saved(saved) => saved,
        Updated::Conflict => panic!("no conflict was asked for"),
    }
}

fn outbox(conn: &Connection) -> Vec<(String, String)> {
    let mut statement = conn
        .prepare("SELECT item_id, op FROM outbox ORDER BY id")
        .expect("prepare");
    statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("rows")
}

fn drain_outbox(conn: &Connection) {
    conn.execute("DELETE FROM outbox", []).expect("drain");
}

fn stored(conn: &Connection, id: &str) -> Value {
    let raw = sync_items::push_payload(conn, ITEM_TYPE, id)
        .expect("read")
        .expect("a payload");
    serde_json::from_str(&raw).expect("JSON")
}

/// `(title, folder, icon, updated_at, deleted_at)` of the projection row.
type Projected = (
    Option<String>,
    Option<String>,
    Option<String>,
    i64,
    Option<i64>,
);

fn projected(conn: &Connection, id: &str) -> Projected {
    conn.query_row(
        "SELECT title, folder, icon, updated_at, deleted_at FROM canvases WHERE id = ?1",
        [id],
        |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        },
    )
    .expect("a projection row")
}

fn canvas_count(conn: &Connection) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM sync_items WHERE item_type = 'canvas'",
        [],
        |row| row.get(0),
    )
    .expect("count")
}

const DEPTH_9: &str = "a/b/c/d/e/f/g/h/i";

#[test]
fn a_create_projects_the_row_and_queues_it() {
    let (db, _dir) = open("canvas-store-create");
    db.call_blocking(|conn| {
        let canvas = NewCanvas {
            folder: Some("Work//Q3/"),
            icon: Some("🎨"),
            ..new_canvas("Board", None)
        };
        let saved = create(conn, &canvas, VAULT_ID, DEVICE, NOW)?;
        assert_eq!(saved.sync, SyncHold::Queued);
        let id = saved.canvas.id.clone();
        assert_eq!(
            projected(conn, &id),
            (
                Some("Board".to_owned()),
                Some("Work/Q3".to_owned()),
                Some("🎨".to_owned()),
                NOW,
                None
            )
        );
        assert_eq!(saved.canvas.created_at, NOW);
        assert_eq!(saved.canvas.scene, EMPTY_SCENE);
        assert_eq!(get(conn, &id)?, Some(saved.canvas));
        assert_eq!(outbox(conn), [(id, "upsert".to_owned())]);
        Ok(())
    })
    .expect("create");
}

#[test]
fn a_list_is_newest_first_and_keeps_to_its_vault() {
    let (db, _dir) = open("canvas-store-list");
    db.call_blocking(|conn| {
        let first = create(conn, &new_canvas("First", None), VAULT_ID, DEVICE, NOW)?;
        create(conn, &new_canvas("Second", None), VAULT_ID, DEVICE, NOW + 1)?;
        create(conn, &new_canvas("Other", None), "vault-2", DEVICE, NOW + 2)?;
        // A payload that named no vault projects `vault_id = ''` and lists in
        // every vault.
        conn.execute(
            "INSERT INTO canvases (id, vault_id, title, created_at, updated_at)
             VALUES ('no-vault', '', 'Anywhere', ?1, ?1)",
            [NOW - 10],
        )
        .map_err(crate::domain::notes::failed)?;
        let titles = |vault: &str| -> Result<Vec<String>, StorageError> {
            Ok(list(conn, vault)?
                .into_iter()
                .map(|canvas| {
                    assert!(canvas.scene.is_empty(), "a list carries no scene");
                    canvas.title.unwrap_or_default()
                })
                .collect())
        };
        assert_eq!(titles(VAULT_ID)?, ["Second", "First", "Anywhere"]);
        assert_eq!(titles("vault-2")?, ["Other", "Anywhere"]);

        update(
            conn,
            &first.canvas.id,
            &CanvasEdit {
                title: Some(Some("First, edited")),
                ..CanvasEdit::default()
            },
            DEVICE,
            NOW + 5,
        )?;
        assert_eq!(titles(VAULT_ID)?, ["First, edited", "Second", "Anywhere"]);
        Ok(())
    })
    .expect("list");
}

#[test]
fn an_update_sets_and_clears_the_title_folder_and_icon() {
    let (db, _dir) = open("canvas-store-update");
    db.call_blocking(|conn| {
        let canvas = NewCanvas {
            folder: Some("Work"),
            icon: Some("🎨"),
            ..new_canvas("Board", None)
        };
        let id = create(conn, &canvas, VAULT_ID, DEVICE, NOW)?.canvas.id;
        drain_outbox(conn);

        let edit = CanvasEdit {
            title: Some(Some("Renamed")),
            folder: Some(Some("Work/../Plans//")),
            icon: Some(Some("🧠")),
            ..CanvasEdit::default()
        };
        let canvas = saved(update(conn, &id, &edit, DEVICE, NOW + 1)?);
        assert_eq!(canvas.sync, SyncHold::Queued);
        assert_eq!(
            projected(conn, &id),
            (
                Some("Renamed".to_owned()),
                Some("Work/Plans".to_owned()),
                Some("🧠".to_owned()),
                NOW + 1,
                None
            )
        );
        assert_eq!(stored(conn, &id)["clock"], json!({ DEVICE: 2 }));
        assert_eq!(stored(conn, &id)["scene"], json!(EMPTY_SCENE));

        let clear = CanvasEdit {
            title: Some(None),
            folder: Some(None),
            icon: Some(None),
            ..CanvasEdit::default()
        };
        saved(update(conn, &id, &clear, DEVICE, NOW + 2)?);
        assert_eq!(projected(conn, &id), (None, None, None, NOW + 2, None));
        let payload = stored(conn, &id);
        assert_eq!(
            (&payload["title"], &payload["folder"], &payload["icon"]),
            (&Value::Null, &Value::Null, &Value::Null)
        );
        assert_eq!(
            outbox(conn),
            [(id, "upsert".to_owned())],
            "two edits collapse to one row"
        );
        Ok(())
    })
    .expect("update");
}

#[test]
fn a_folder_past_the_depth_cap_is_refused_with_nothing_written() {
    let (db, _dir) = open("canvas-store-depth");
    db.call_blocking(|conn| {
        let deep = NewCanvas {
            folder: Some(DEPTH_9),
            ..new_canvas("Deep", None)
        };
        let error = create(conn, &deep, VAULT_ID, DEVICE, NOW).expect_err("depth 9");
        assert!(error.to_string().contains("CANVAS_FOLDER_DEPTH"), "{error}");
        assert_eq!(canvas_count(conn), 0);
        assert!(outbox(conn).is_empty());

        let eight = NewCanvas {
            folder: Some("a/b/c/d/e/f/g/h"),
            ..new_canvas("Eight", None)
        };
        let id = create(conn, &eight, VAULT_ID, DEVICE, NOW)?.canvas.id;
        drain_outbox(conn);
        let before = stored(conn, &id);
        let edit = CanvasEdit {
            folder: Some(Some(DEPTH_9)),
            title: Some(Some("Moved")),
            ..CanvasEdit::default()
        };
        let error = update(conn, &id, &edit, DEVICE, NOW + 1).expect_err("depth 9");
        assert!(error.to_string().contains("CANVAS_FOLDER_DEPTH"), "{error}");
        assert_eq!(stored(conn, &id), before);
        assert_eq!(projected(conn, &id).3, NOW);
        assert!(outbox(conn).is_empty());
        Ok(())
    })
    .expect("depth");
}

#[test]
fn a_stale_expected_updated_at_is_a_conflict_that_writes_nothing() {
    let (db, _dir) = open("canvas-store-conflict");
    db.call_blocking(|conn| {
        let id = create(conn, &new_canvas("Board", None), VAULT_ID, DEVICE, NOW)?
            .canvas
            .id;
        drain_outbox(conn);
        let before = stored(conn, &id);
        let stale = CanvasEdit {
            title: Some(Some("Lost")),
            expected_updated_at: Some(NOW - 1),
            ..CanvasEdit::default()
        };
        assert_eq!(
            update(conn, &id, &stale, DEVICE, NOW + 1)?,
            Updated::Conflict
        );
        assert_eq!(stored(conn, &id), before);
        assert!(outbox(conn).is_empty());

        let current = CanvasEdit {
            expected_updated_at: Some(NOW),
            ..stale
        };
        let canvas = saved(update(conn, &id, &current, DEVICE, NOW + 1)?).canvas;
        assert_eq!(canvas.title.as_deref(), Some("Lost"));
        Ok(())
    })
    .expect("conflict");
}

#[test]
fn a_scene_at_the_cap_queues_and_one_byte_over_is_saved_but_held_back() {
    let (db, _dir) = open("canvas-store-cap");
    db.call_blocking(|conn| {
        let at_cap = scene_of_len(CANVAS_SCENE_SYNC_CAP_BYTES);
        let saved_at_cap = create(
            conn,
            &new_canvas("Big", Some(&at_cap)),
            VAULT_ID,
            DEVICE,
            NOW,
        )?;
        assert_eq!(saved_at_cap.sync, SyncHold::Queued);
        let id = saved_at_cap.canvas.id;
        assert_eq!(outbox(conn), [(id.clone(), "upsert".to_owned())]);
        drain_outbox(conn);

        let over = scene_of_len(CANVAS_SCENE_SYNC_CAP_BYTES + 1);
        let edit = CanvasEdit {
            scene: Some(&over),
            ..CanvasEdit::default()
        };
        let held = saved(update(conn, &id, &edit, DEVICE, NOW + 1)?);
        assert_eq!(
            held.sync,
            SyncHold::TooLarge {
                bytes: CANVAS_SCENE_SYNC_CAP_BYTES + 1
            }
        );
        assert!(outbox(conn).is_empty(), "an over-cap scene queues nothing");
        // Saved locally all the same, clock ticked, so a later remote edit
        // resolves as concurrent (`bumpCanvasClockLocalOnly`).
        assert_eq!(held.canvas.scene, over);
        assert_eq!(stored(conn, &id)["scene"], json!(over));
        assert_eq!(stored(conn, &id)["clock"], json!({ DEVICE: 2 }));
        assert_eq!(projected(conn, &id).3, NOW + 1);
        assert_eq!(get(conn, &id)?.expect("live").scene, over);
        Ok(())
    })
    .expect("cap");
}

#[test]
fn an_over_cap_create_is_saved_and_held_back() {
    let (db, _dir) = open("canvas-store-cap-create");
    db.call_blocking(|conn| {
        let over = scene_of_len(CANVAS_SCENE_SYNC_CAP_BYTES + 1);
        let saved = create(
            conn,
            &new_canvas("Import", Some(&over)),
            VAULT_ID,
            DEVICE,
            NOW,
        )?;
        assert_eq!(
            saved.sync,
            SyncHold::TooLarge {
                bytes: CANVAS_SCENE_SYNC_CAP_BYTES + 1
            }
        );
        assert!(outbox(conn).is_empty());
        assert_eq!(get(conn, &saved.canvas.id)?.expect("live").scene, over);
        Ok(())
    })
    .expect("over-cap create");
}

#[test]
fn a_title_edit_of_an_over_cap_canvas_is_held_back_until_the_scene_shrinks() {
    let (db, _dir) = open("canvas-store-cap-title");
    db.call_blocking(|conn| {
        let over = scene_of_len(CANVAS_SCENE_SYNC_CAP_BYTES + 1);
        let id = create(conn, &new_canvas("Big", Some(&over)), VAULT_ID, DEVICE, NOW)?
            .canvas
            .id;

        let rename = CanvasEdit {
            title: Some(Some("Renamed")),
            ..CanvasEdit::default()
        };
        let held = saved(update(conn, &id, &rename, DEVICE, NOW + 1)?);
        assert_eq!(
            held.sync,
            SyncHold::TooLarge {
                bytes: CANVAS_SCENE_SYNC_CAP_BYTES + 1
            }
        );
        assert!(
            outbox(conn).is_empty(),
            "the push would carry the big scene"
        );
        assert_eq!(projected(conn, &id).0.as_deref(), Some("Renamed"));
        assert_eq!(stored(conn, &id)["clock"], json!({ DEVICE: 2 }));

        let shrink = CanvasEdit {
            scene: Some(EMPTY_SCENE),
            ..CanvasEdit::default()
        };
        let queued = saved(update(conn, &id, &shrink, DEVICE, NOW + 2)?);
        assert_eq!(queued.sync, SyncHold::Queued);
        assert_eq!(outbox(conn), [(id.clone(), "upsert".to_owned())]);
        let payload = stored(conn, &id);
        assert_eq!(
            (&payload["title"], &payload["scene"]),
            (&json!("Renamed"), &json!(EMPTY_SCENE)),
            "the push carries the held-back title"
        );
        Ok(())
    })
    .expect("over-cap title");
}

#[test]
fn a_delete_tombstones_the_projection_and_queues_the_delete() {
    let (db, _dir) = open("canvas-store-delete");
    db.call_blocking(|conn| {
        let id = create(conn, &new_canvas("Board", None), VAULT_ID, DEVICE, NOW)?
            .canvas
            .id;
        drain_outbox(conn);
        assert!(delete(conn, &id, DEVICE, NOW + 1)?);
        assert_eq!(get(conn, &id)?, None);
        assert_eq!(projected(conn, &id).4, Some(NOW + 1));
        assert!(list(conn, VAULT_ID)?.is_empty());
        assert_eq!(outbox(conn), [(id.clone(), "delete".to_owned())]);
        assert!(!delete(conn, &id, DEVICE, NOW + 2)?, "already gone");
        assert!(!delete(conn, "never-was", DEVICE, NOW + 2)?);
        let edit = CanvasEdit {
            title: Some(Some("Zombie")),
            ..CanvasEdit::default()
        };
        assert!(matches!(
            update(conn, &id, &edit, DEVICE, NOW + 3),
            Err(StorageError::NotFound { .. })
        ));
        Ok(())
    })
    .expect("delete");
}

/// The tombstone of a canvas too big to sync drops its scene, so the delete
/// seals under the item limit instead of retiring unsent (a retired delete
/// never reaches peers, and their next edit revives the canvas here).
#[test]
fn deleting_an_over_cap_canvas_queues_a_delete_that_fits_the_item_limit() {
    let (db, _dir) = open("canvas-store-delete-over-cap");
    db.call_blocking(|conn| {
        let over = scene_of_len(NOTE_SYNC_MAX_BYTES + 1);
        let id = create(
            conn,
            &new_canvas("Huge", Some(&over)),
            VAULT_ID,
            DEVICE,
            NOW,
        )?
        .canvas
        .id;
        assert!(delete(conn, &id, DEVICE, NOW + 1)?);
        assert_eq!(outbox(conn), [(id.clone(), "delete".to_owned())]);
        let payload = sync_items::push_payload(conn, ITEM_TYPE, &id)?.expect("tombstone");
        let sealable = check_size(payload.len());
        assert!(sealable.is_ok(), "{sealable:?}");
        assert_eq!(stored(conn, &id)["deletedAt"], json!(NOW + 1));
        Ok(())
    })
    .expect("over-cap delete");
}

#[test]
fn a_duplicate_copies_the_scene_and_the_asset_rows() {
    let (db, _dir) = open("canvas-store-duplicate");
    db.call_blocking(|conn| {
        let scene = r#"{"elements":[{"id":"img","type":"image","fileId":"f1"}]}"#;
        let source = NewCanvas {
            folder: Some("Work"),
            icon: Some("🎨"),
            owner_note_id: Some("note-1"),
            ..new_canvas("Original", Some(scene))
        };
        let source = create(conn, &source, VAULT_ID, DEVICE, NOW)?.canvas;
        for hash in ["h1", "h2"] {
            conn.execute(
                "INSERT INTO canvas_assets (vault_id, canvas_id, content_hash, attachment_id,
                     file_id, filename, mime_type, size_bytes, chunk_hashes, created_at)
                 VALUES (?1, ?2, ?3, 'att', 'f1', 'a.png', 'image/png', 10, '[]', ?4)",
                params![VAULT_ID, source.id, hash, NOW],
            )
            .map_err(crate::domain::notes::failed)?;
        }
        drain_outbox(conn);

        let copy = duplicate(
            conn,
            &source.id,
            Some("Original copy"),
            VAULT_ID,
            DEVICE,
            NOW + 1,
        )?
        .expect("a live source");
        assert_eq!(copy.sync, SyncHold::Queued);
        let copy = copy.canvas;
        assert_ne!(copy.id, source.id);
        assert_eq!(copy.title.as_deref(), Some("Original copy"));
        assert_eq!(
            (
                copy.scene.as_str(),
                copy.folder.as_deref(),
                copy.icon.as_deref()
            ),
            (source.scene.as_str(), Some("Work"), Some("🎨"))
        );
        assert_eq!(copy.owner_note_id, None);
        let hashes: Vec<String> = conn
            .prepare("SELECT content_hash FROM canvas_assets WHERE canvas_id = ?1 ORDER BY 1")
            .and_then(|mut statement| statement.query_map([&copy.id], |row| row.get(0))?.collect())
            .map_err(crate::domain::notes::failed)?;
        assert_eq!(hashes, ["h1", "h2"]);
        assert_eq!(outbox(conn), [(copy.id, "upsert".to_owned())]);
        assert_eq!(
            duplicate(conn, "never-was", None, VAULT_ID, DEVICE, NOW)?,
            None
        );
        Ok(())
    })
    .expect("duplicate");
}

#[test]
fn a_remote_apply_and_a_remote_tombstone_update_the_projection() {
    let (db, _dir) = open("canvas-store-remote");
    db.call_blocking(|conn| {
        let id = create(conn, &new_canvas("Board", None), VAULT_ID, DEVICE, NOW)?
            .canvas
            .id;
        drain_outbox(conn);
        let record = InboundRecord {
            item_type: ITEM_TYPE.to_owned(),
            item_id: id.clone(),
            payload_json: json!({
                "id": id, "vaultId": VAULT_ID, "title": "From desktop", "scene": EMPTY_SCENE,
                "folder": "Inbox/", "icon": null, "ownerNoteId": null,
                "clock": { DEVICE: 1, "device-B": 1 }, "deletedAt": null,
            })
            .to_string(),
            server_cursor: Some(9),
            signer_device_id: Some("device-B".to_owned()),
            updated_at: NOW + 5,
            deleted_at: None,
        };
        assert_eq!(
            apply_inbound(conn, &record, NOW + 5)?,
            ApplyOutcome::Applied
        );
        assert_eq!(
            projected(conn, &id),
            (
                Some("From desktop".to_owned()),
                Some("Inbox".to_owned()),
                None,
                NOW + 5,
                None
            )
        );
        assert_eq!(get(conn, &id)?.expect("live").created_at, NOW);

        let tombstone = Pending::Tombstone {
            item_type: ITEM_TYPE.to_owned(),
            item_id: id.clone(),
            deleted_at: NOW + 6,
            server_cursor: None,
            clock: Some(clock_of([(DEVICE, 1), ("device-B", 2)])),
            body_state_vector: None,
        };
        let page = apply_page(
            conn,
            vec![tombstone],
            vec![],
            NOW + 6,
            Some(DEVICE),
            &crate::crypto::agent_envelope::AtRestKey::default(),
        )?;
        assert_eq!(page.deleted, 1);
        assert_eq!(get(conn, &id)?, None);
        assert!(projected(conn, &id).4.is_some());
        assert!(list(conn, VAULT_ID)?.is_empty());
        Ok(())
    })
    .expect("remote");
}
