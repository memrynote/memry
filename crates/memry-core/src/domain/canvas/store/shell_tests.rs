//! What desktop's file service needs of the store: it names the file before
//! the record exists, so it picks the new canvas's id, and it duplicates the
//! scene of the file, which can be newer than the payload's.

use super::super::{CanvasCopy, NewCanvas, canonical_scene, create, duplicate, get};
use crate::storage::{open_data, test_support::temp_dir};

const VAULT_ID: &str = "vault-1";
const DEVICE: &str = "device-LOCAL";
const NOW: i64 = 1_760_000_000_000;

#[test]
fn a_canvas_is_created_under_the_id_the_shell_picked() {
    let dir = temp_dir("canvas-store-shell-id");
    let db = open_data(&dir.path().join("data.db")).expect("open data.db");
    db.call_blocking(|conn| {
        let canvas = NewCanvas {
            id: Some("picked-id"),
            title: Some("Plan"),
            ..NewCanvas::default()
        };
        let saved = create(conn, &canvas, VAULT_ID, DEVICE, NOW)?;
        assert_eq!(saved.canvas.id, "picked-id");
        assert!(get(conn, "picked-id")?.is_some());
        let blank = NewCanvas {
            id: Some(""),
            ..NewCanvas::default()
        };
        assert!(create(conn, &blank, VAULT_ID, DEVICE, NOW).is_err());
        Ok(())
    })
    .expect("create");
}

#[test]
fn a_duplicate_takes_the_shell_id_and_the_scene_it_read() {
    let dir = temp_dir("canvas-store-shell-duplicate");
    let db = open_data(&dir.path().join("data.db")).expect("open data.db");
    db.call_blocking(|conn| {
        let source = NewCanvas {
            title: Some("Plan"),
            scene: Some(r#"{"elements":[]}"#),
            ..NewCanvas::default()
        };
        let source = create(conn, &source, VAULT_ID, DEVICE, NOW)?.canvas;
        let on_disk = r#"{"elements":[{"id":"a","type":"rectangle"}]}"#;
        let copy = CanvasCopy {
            title: Some("Plan 2"),
            id: Some("copy-id"),
            scene: Some(on_disk),
        };
        let copy = duplicate(conn, &source.id, &copy, VAULT_ID, DEVICE, NOW + 1)?
            .expect("a live source")
            .canvas;
        assert_eq!(copy.id, "copy-id");
        assert_eq!(copy.scene, canonical_scene(on_disk)?);
        assert_ne!(copy.scene, source.scene);
        let gone = duplicate(
            conn,
            "never-was",
            &CanvasCopy::default(),
            VAULT_ID,
            DEVICE,
            NOW,
        )?;
        assert_eq!(gone, None);
        Ok(())
    })
    .expect("duplicate");
}
