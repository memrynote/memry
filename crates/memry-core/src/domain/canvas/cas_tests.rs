//! The guarded scene write and the per-note listing (#4820): a shell that read
//! a scene, edited it, and writes it back must not overwrite a pull that landed
//! in between, and must be able to find the conflict copy a pull made.

use serde_json::json;

use super::tests::{LOCAL_DEVICE, NOW, VAULT_ID, inbound, open, outbox, scene_with, seed, stored};
use super::{ITEM_TYPE, SceneWrite, canonical_scene, list_owned_by, set_scene_expecting};
use crate::storage::repositories::sync_items::ApplyOutcome;
use crate::sync::apply::{apply_inbound, apply_inbound_on};

#[test]
fn a_guarded_write_over_a_scene_a_pull_changed_is_refused_and_returns_the_new_scene() {
    let (db, _dir) = open("canvas-cas-stale");
    db.call_blocking(|conn| {
        seed(
            conn,
            "c1",
            &scene_with("note-1"),
            json!({ "A": 1 }),
            json!({}),
        );
        // The shell reads the scene ...
        let read = super::get(conn, "c1")?.expect("live").scene;
        // ... a desktop edit is pulled before the shell writes ...
        let desktop = inbound(
            "c1",
            json!({ "id": "c1", "vaultId": VAULT_ID, "scene": scene_with("note-desktop"),
                    "clock": { "A": 1, "B": 2 } }),
        );
        assert_eq!(apply_inbound(conn, &desktop, NOW)?, ApplyOutcome::Applied);
        // ... and the shell's write, built on the old read, is refused.
        let ink = scene_with("note-ink");
        let SceneWrite::Stale(current) =
            set_scene_expecting(conn, "c1", &ink, &read, LOCAL_DEVICE, NOW)?
        else {
            panic!("a write over a changed scene must be refused");
        };
        assert_eq!(current.scene, scene_with("note-desktop"));
        assert_eq!(
            stored(conn, "c1")["scene"],
            json!(scene_with("note-desktop"))
        );
        assert_eq!(stored(conn, "c1")["clock"], json!({ "A": 1, "B": 2 }));
        assert_eq!(outbox(conn), []);
        Ok(())
    })
    .expect("stale");
}

#[test]
fn a_guarded_write_over_the_scene_it_read_is_written_and_queued() {
    let (db, _dir) = open("canvas-cas-match");
    db.call_blocking(|conn| {
        seed(
            conn,
            "c1",
            &scene_with("note-1"),
            json!({ "B": 3 }),
            json!({}),
        );
        let read = super::get(conn, "c1")?.expect("live").scene;
        let ink = scene_with("note-ink");
        let SceneWrite::Written(canvas) =
            set_scene_expecting(conn, "c1", &ink, &read, LOCAL_DEVICE, NOW)?
        else {
            panic!("a write over the scene it read must land");
        };
        assert_eq!(canvas.scene, canonical_scene(&ink)?);
        let row = stored(conn, "c1");
        assert_eq!(row["scene"], json!(canonical_scene(&ink)?));
        assert_eq!(row["clock"], json!({ "B": 3, LOCAL_DEVICE: 1 }));
        assert_eq!(
            outbox(conn),
            [(ITEM_TYPE.to_owned(), "c1".to_owned(), "upsert".to_owned())]
        );
        Ok(())
    })
    .expect("match");
}

#[test]
fn a_guarded_write_to_a_deleted_canvas_is_not_found() {
    let (db, _dir) = open("canvas-cas-missing");
    db.call_blocking(|conn| {
        let error =
            set_scene_expecting(conn, "gone", "", "", LOCAL_DEVICE, NOW).expect_err("no canvas");
        assert!(matches!(
            error,
            crate::api::errors::StorageError::NotFound { .. }
        ));
        Ok(())
    })
    .expect("missing");
}

#[test]
fn the_conflict_copy_a_pull_makes_is_listed_under_the_same_note() {
    let (db, _dir) = open("canvas-list-owner");
    db.call_blocking(|conn| {
        seed(
            conn,
            "c1",
            &scene_with("note-ink"),
            json!({ "A": 2 }),
            json!({ "ownerNoteId": "note-1" }),
        );
        seed(
            conn,
            "other",
            &scene_with("note-x"),
            json!({ "A": 1 }),
            json!({ "ownerNoteId": "note-2" }),
        );
        let desktop = inbound(
            "c1",
            json!({ "id": "c1", "vaultId": VAULT_ID, "scene": scene_with("note-desktop"),
                    "clock": { "B": 3 } }),
        );
        assert_eq!(
            apply_inbound_on(conn, &desktop, NOW, Some(LOCAL_DEVICE))?,
            ApplyOutcome::Applied
        );

        let owned = list_owned_by(conn, "note-1")?;
        assert_eq!(owned.len(), 2, "{owned:?}");
        let copy = owned
            .iter()
            .find(|canvas| canvas.id != "c1")
            .expect("the copy");
        assert_eq!(copy.title.as_deref(), Some("My Canvas (conflict copy)"));
        assert_eq!(copy.owner_note_id.as_deref(), Some("note-1"));
        assert_eq!(copy.scene, scene_with("note-ink"));
        assert!(owned.iter().any(|canvas| canvas.id == "c1"));
        assert_eq!(list_owned_by(conn, "note-none")?, []);
        Ok(())
    })
    .expect("list");
}

#[test]
fn a_deleted_canvas_is_not_listed() {
    let (db, _dir) = open("canvas-list-deleted");
    db.call_blocking(|conn| {
        seed(
            conn,
            "c1",
            &scene_with("note-1"),
            json!({ "A": 1 }),
            json!({ "ownerNoteId": "note-1" }),
        );
        conn.execute(
            "UPDATE sync_items SET deleted_at = ?1 WHERE item_id = 'c1'",
            [NOW],
        )
        .expect("tombstone");
        assert_eq!(list_owned_by(conn, "note-1")?, []);
        Ok(())
    })
    .expect("deleted");
}
