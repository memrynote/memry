//! Canvas image assets on a real temp vault (#3547 30e3): the `canvas_assets` rows in `data.db`
//! and the content-addressed files under `attachments/canvas-assets/` (Electron's
//! `canvas/assets/asset-service.ts`, `asset-store.ts`, `memry-assets.ts`).
//!
//! | Test                                                          | Electron                          |
//! | ------------------------------------------------------------- | --------------------------------- |
//! | a save carries the sidecar of the images the scene shows      | `canvas-handlers.ts:139`, `asset-service.ts:403` |
//! | an empty save stays the empty board, with no sidecar           | `asset-service.ts:408`            |
//! | list and ref read the canvas's rows                           | `asset-service.ts:381,394`        |
//! | a dedup hit writes the bytes once and records the row          | `asset-service.ts:121-170`        |
//! | a deleted canvas past its grace is no dedup source             | `asset-store.ts:36-63`            |
//! | new bytes with no uploader write nothing                       | `asset-service-context.ts:61` (no sync) |
//! | a row naming a file outside the store is never served          | departure: Electron joins it      |
//! | a store folder linking out of the vault is never written       | departure: Electron follows it    |
//! | dropping an image or deleting the canvas keeps its file        | `asset-service.ts:279-300` (release fails offline) |

use std::fs;
use std::path::PathBuf;

use memry_desktop::canvas::assets::{AssetError, CanvasUploadAssetInput};
use memry_desktop::canvas::service::{CanvasUpdateInput, Update};
use rusqlite::{Connection, params};
use serde_json::Value;
use sha2::{Digest as _, Sha256};

use super::canvas_service::{NOW, World, world};

const PNG: &[u8] = b"\x89PNG\r\n\x1a\n not really a png";

fn hash(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

impl World {
    fn data_db(&self) -> Connection {
        Connection::open(self.vault.join(".memry").join("core").join("data.db")).unwrap()
    }

    fn vault_id(&self) -> String {
        self.data_db()
            .query_row("SELECT vault_id FROM canvases LIMIT 1", [], |row| {
                row.get(0)
            })
            .unwrap()
    }

    /// A row as Electron's upload records it.
    fn record(&self, canvas_id: &str, content_hash: &str, file_id: &str, filename: &str) {
        self.data_db()
            .execute(
                "INSERT INTO canvas_assets (vault_id, canvas_id, content_hash, attachment_id,
                     file_id, filename, mime_type, size_bytes, chunk_hashes, created_at)
                 VALUES (?1, ?2, ?3, 'att-1', ?4, ?5, 'image/png', ?6, '[\"c1\",\"c2\"]', ?7)",
                params![
                    self.vault_id(),
                    canvas_id,
                    content_hash,
                    file_id,
                    filename,
                    PNG.len() as i64,
                    NOW
                ],
            )
            .unwrap();
    }

    fn rows(&self, canvas_id: &str) -> Vec<String> {
        let db = self.data_db();
        let mut stmt = db
            .prepare("SELECT content_hash FROM canvas_assets WHERE canvas_id = ?1")
            .unwrap();
        stmt.query_map([canvas_id], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }

    fn store_file(&self, filename: &str) -> PathBuf {
        self.vault
            .join("attachments")
            .join("canvas-assets")
            .join(filename)
    }

    fn asset_url(&self, filename: &str) -> String {
        let path = self.store_file(filename);
        let path = path.to_string_lossy().replace('\\', "/");
        format!("memry-file://local/{}", path.trim_start_matches('/'))
    }

    fn scene_with_image(&self, file_id: &str, filename: &str) -> String {
        serde_json::json!({
            "type": "excalidraw", "version": 2, "source": "memry",
            "elements": [{ "id": "img", "type": "image", "fileId": file_id }],
            "appState": {},
            "files": { file_id: { "id": file_id, "mimeType": "image/png",
                                  "dataURL": self.asset_url(filename) } }
        })
        .to_string()
    }

    fn save_scene(&self, id: &str, scene: &str) -> Update {
        let read = self.canvases.get(id).unwrap().unwrap();
        let input = CanvasUpdateInput {
            id: id.to_owned(),
            scene: Some(scene.to_owned()),
            expected_sha256: read.sha256,
            ..CanvasUpdateInput::default()
        };
        self.canvases.update(&input, NOW + 10).unwrap()
    }

    fn upload(&self, canvas_id: &str, file_id: &str, bytes: &[u8]) -> Result<Value, AssetError> {
        let input = CanvasUploadAssetInput {
            canvas_id: canvas_id.to_owned(),
            file_id: file_id.to_owned(),
            mime_type: "image/png".to_owned(),
            data: bytes.to_vec(),
        };
        self.canvases
            .upload_asset(&input, NOW + 20)
            .map(|uploaded| serde_json::to_value(uploaded).unwrap())
    }
}

fn sidecar(text: &str) -> Value {
    serde_json::from_str::<Value>(text).unwrap()["memryAssets"].clone()
}

#[test]
fn a_save_carries_the_sidecar_of_the_images_the_scene_shows() {
    let w = world();
    let id = w.create("Board", None, "a").canvas.summary.id;
    let shown = hash(PNG);
    let dropped = hash(b"another image");
    w.record(&id, &shown, "f1", &format!("{shown}.png"));
    w.record(&id, &dropped, "f2", &format!("{dropped}.png"));

    w.save_scene(&id, &w.scene_with_image("f1", &format!("{shown}.png")));

    let on_disk = sidecar(&w.file("canvases/Board.excalidraw"));
    let descriptors = on_disk.as_array().unwrap();
    assert_eq!(descriptors.len(), 1, "only the image the scene shows");
    assert_eq!(descriptors[0]["contentHash"], shown);
    assert_eq!(descriptors[0]["attachmentId"], "att-1");
    assert_eq!(descriptors[0]["fileId"], "f1");
    assert_eq!(
        descriptors[0]["chunkHashes"],
        serde_json::json!(["c1", "c2"])
    );
    assert_eq!(descriptors[0]["sizeBytes"], PNG.len());
    assert_eq!(descriptors[0]["filename"], format!("{shown}.png"));
    assert_eq!(
        sidecar(&w.canvases.get(&id).unwrap().unwrap().scene),
        on_disk
    );

    // A scene with no externalized image carries an empty sidecar, as Electron writes it.
    w.save_scene(&id, &super::canvas_service::scene("b"));
    assert_eq!(
        sidecar(&w.file("canvases/Board.excalidraw")),
        serde_json::json!([])
    );
}

#[test]
fn an_empty_save_stays_the_empty_board_with_no_sidecar() {
    let w = world();
    let id = w.create("Board", None, "a").canvas.summary.id;
    w.save_scene(&id, "");
    assert_eq!(sidecar(&w.file("canvases/Board.excalidraw")), Value::Null);
}

#[test]
fn list_and_ref_read_the_canvas_rows() {
    let w = world();
    let id = w.create("Board", None, "a").canvas.summary.id;
    let other = w.create("Other", None, "b").canvas.summary.id;
    let h = hash(PNG);
    w.record(&id, &h, "f1", &format!("{h}.png"));

    let listed = w.canvases.list_assets(&id).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].content_hash, h);
    assert!(w.canvases.list_assets(&other).unwrap().is_empty());

    assert_eq!(
        w.canvases.asset_ref(&id, "f1").unwrap(),
        Some(w.asset_url(&format!("{h}.png")))
    );
    assert_eq!(w.canvases.asset_ref(&id, "nope").unwrap(), None);
    assert_eq!(w.canvases.asset_ref(&other, "f1").unwrap(), None);
}

#[test]
fn a_dedup_hit_writes_the_bytes_once_and_records_the_row() {
    let w = world();
    let source = w.create("Source", None, "a").canvas.summary.id;
    let target = w.create("Target", None, "b").canvas.summary.id;
    let h = hash(PNG);
    w.record(&source, &h, "f1", &format!("{h}.png"));

    let uploaded = w.upload(&target, "f9", PNG).unwrap();
    assert_eq!(uploaded["deduped"], true);
    assert_eq!(uploaded["ref"], w.asset_url(&format!("{h}.png")));
    assert_eq!(uploaded["descriptor"]["attachmentId"], "att-1");
    assert_eq!(uploaded["descriptor"]["fileId"], "f9");
    assert_eq!(fs::read(w.store_file(&format!("{h}.png"))).unwrap(), PNG);
    assert_eq!(w.rows(&target), vec![h.clone()]);

    // A file already in the store is these bytes: it is left as it is.
    fs::write(w.store_file(&format!("{h}.png")), b"kept").unwrap();
    w.upload(&target, "f9", PNG).unwrap();
    assert_eq!(
        fs::read(w.store_file(&format!("{h}.png"))).unwrap(),
        b"kept"
    );
    let leftovers: Vec<_> = fs::read_dir(w.store_file(""))
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(leftovers.len(), 1, "no temp file left: {leftovers:?}");
}

#[test]
fn a_deleted_canvas_past_its_grace_is_no_dedup_source() {
    let w = world();
    let source = w.create("Source", None, "a").canvas.summary.id;
    let target = w.create("Target", None, "b").canvas.summary.id;
    let h = hash(PNG);
    w.record(&source, &h, "f1", &format!("{h}.png"));
    assert!(w.canvases.delete(&source, NOW + 5).unwrap());

    // A delete with no release record of this device is a peer's: never a source.
    assert!(matches!(
        w.upload(&target, "f9", PNG),
        Err(AssetError::UploadUnavailable)
    ));
    // This device's own delete, released inside the grace period, still is.
    w.data_db()
        .execute(
            "INSERT INTO deleted_asset_releases (item_type, item_id, deleted_at)
             VALUES ('canvas', ?1, ?2)",
            params![source, NOW + 5],
        )
        .unwrap();
    assert_eq!(w.upload(&target, "f9", PNG).unwrap()["deduped"], true);
}

#[test]
fn new_bytes_with_no_uploader_write_nothing() {
    let w = world();
    let id = w.create("Board", None, "a").canvas.summary.id;
    assert!(matches!(
        w.upload(&id, "f1", PNG),
        Err(AssetError::UploadUnavailable)
    ));
    assert!(!w.vault.join("attachments").exists());
    assert!(w.rows(&id).is_empty());
}

#[test]
fn a_row_naming_a_file_outside_the_store_is_never_served() {
    let w = world();
    let id = w.create("Board", None, "a").canvas.summary.id;
    let target = w.create("Target", None, "b").canvas.summary.id;
    let h = hash(PNG);
    w.record(&id, &h, "f1", "../../canvases/Board.excalidraw");
    w.record(&id, "abc", "f2", "/etc/hosts");

    assert_eq!(w.canvases.asset_ref(&id, "f1").unwrap(), None);
    assert_eq!(w.canvases.asset_ref(&id, "f2").unwrap(), None);
    assert!(matches!(
        w.upload(&target, "f9", PNG),
        Err(AssetError::Escape)
    ));
    assert!(!w.vault.join("attachments").exists());
}

#[cfg(unix)]
#[test]
fn a_store_folder_linking_out_of_the_vault_is_never_written() {
    let w = world();
    let source = w.create("Source", None, "a").canvas.summary.id;
    let target = w.create("Target", None, "b").canvas.summary.id;
    let h = hash(PNG);
    w.record(&source, &h, "f1", &format!("{h}.png"));
    let outside = tempfile::tempdir().unwrap();
    fs::create_dir_all(w.vault.join("attachments")).unwrap();
    std::os::unix::fs::symlink(
        outside.path(),
        w.vault.join("attachments").join("canvas-assets"),
    )
    .unwrap();

    assert!(matches!(
        w.upload(&target, "f9", PNG),
        Err(AssetError::Escape)
    ));
    assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
    assert_eq!(w.canvases.asset_ref(&source, "f1").unwrap(), None);
}

#[test]
fn dropping_an_image_or_deleting_the_canvas_keeps_its_file() {
    let w = world();
    let source = w.create("Source", None, "a").canvas.summary.id;
    let id = w.create("Board", None, "b").canvas.summary.id;
    let h = hash(PNG);
    let filename = format!("{h}.png");
    w.record(&source, &h, "f1", &filename);
    w.upload(&id, "f1", PNG).unwrap();
    w.save_scene(&id, &w.scene_with_image("f1", &filename));

    w.save_scene(&id, &super::canvas_service::scene("c"));
    assert!(w.store_file(&filename).exists());
    assert_eq!(w.rows(&id), vec![h.clone()], "the row waits for the server");

    assert!(w.canvases.delete(&id, NOW + 30).unwrap());
    assert!(w.store_file(&filename).exists());
}

/// A sidecar descriptor as Electron's upload writes it.
fn descriptor(content_hash: &str, file_id: &str, attachment_id: &str) -> Value {
    serde_json::json!({
        "fileId": file_id, "attachmentId": attachment_id, "contentHash": content_hash,
        "chunkHashes": ["c1"], "mimeType": "image/png", "sizeBytes": 10,
        "filename": format!("{content_hash}.png"),
    })
}

impl World {
    /// A scene showing two stored images, as the editor saves it: no sidecar of its own.
    fn scene_with_two_images(&self, a: &str, b: &str) -> String {
        serde_json::json!({
            "type": "excalidraw", "version": 2, "source": "memry",
            "elements": [{ "id": "i1", "type": "image", "fileId": "f1" },
                         { "id": "i2", "type": "image", "fileId": "f2" }],
            "appState": {},
            "files": {
                "f1": { "id": "f1", "mimeType": "image/png",
                        "dataURL": self.asset_url(&format!("{a}.png")) },
                "f2": { "id": "f2", "mimeType": "image/png",
                        "dataURL": self.asset_url(&format!("{b}.png")) }
            }
        })
        .to_string()
    }

    /// The same scene as a peer pushed it, with its `memryAssets` sidecar.
    fn scene_with_sidecar(&self, a: &str, b: &str) -> String {
        let mut scene: Value = serde_json::from_str(&self.scene_with_two_images(a, b)).unwrap();
        scene["memryAssets"] =
            serde_json::json!([descriptor(a, "f1", "att-a"), descriptor(b, "f2", "att-b")]);
        scene.to_string()
    }

    /// The scene of the payload the next push sends, `None` when no push is queued.
    fn queued_scene(&self, id: &str) -> Option<String> {
        let db = self.data_db();
        let queued: bool = db
            .query_row(
                "SELECT EXISTS (SELECT 1 FROM outbox WHERE item_type = 'canvas' AND item_id = ?1)",
                [id],
                |row| row.get(0),
            )
            .unwrap();
        let payload: String = db
            .query_row(
                "SELECT payload FROM sync_items WHERE item_type = 'canvas' AND item_id = ?1",
                [id],
                |row| row.get(0),
            )
            .unwrap();
        let payload: Value = serde_json::from_str(&payload).unwrap();
        queued.then(|| payload["scene"].as_str().unwrap().to_owned())
    }

    /// Opens the canvas and saves the scene the editor shows, as the editor does on mount.
    fn open_and_save(&self, id: &str, scene: &str) -> Update {
        self.data_db().execute("DELETE FROM outbox", []).unwrap();
        self.save_scene(id, scene)
    }
}

fn hashes(sidecar: &Value) -> Vec<String> {
    sidecar
        .as_array()
        .expect("a sidecar")
        .iter()
        .map(|d| d["contentHash"].as_str().unwrap().to_owned())
        .collect()
}

fn saved_path(w: &World, id: &str) -> String {
    let db = w.data_db();
    db.query_row(
        "SELECT file_path FROM canvas_files WHERE canvas_id = ?1",
        [id],
        |row| row.get(0),
    )
    .unwrap()
}

#[test]
fn an_adopted_canvas_keeps_its_sidecar_images_through_open_and_save() {
    let w = world();
    w.create("Seed", None, "a");
    let (a, b) = (hash(b"image a"), hash(b"image b"));
    // Reconcile's adopt (`canvas/reconcile.rs` on #5211, Electron `reconcile.ts:593`) records a
    // document no row names through `canvas::create` with the document's scene.
    let id = memry_core::domain::canvas::new_id();
    memry_core::domain::canvas::create(
        &w.data_db(),
        &memry_core::domain::canvas::NewCanvas {
            id: Some(&id),
            title: Some("Adopted"),
            scene: Some(&w.scene_with_sidecar(&a, &b)),
            ..Default::default()
        },
        &w.vault_id(),
        "device-x",
        NOW,
    )
    .unwrap();

    w.open_and_save(&id, &w.scene_with_two_images(&a, &b));

    let saved = w.file(&saved_path(&w, &id));
    assert_eq!(hashes(&sidecar(&saved)), vec![a.clone(), b.clone()]);
    let pushed = w.queued_scene(&id).expect("the save is queued");
    assert_eq!(hashes(&sidecar(&pushed)), vec![a.clone(), b.clone()]);
    assert_eq!(sidecar(&pushed)[1]["attachmentId"], "att-b");
}

#[test]
fn a_pulled_canvas_keeps_its_sidecar_images_through_open_and_save() {
    let w = world();
    w.create("Seed", None, "a");
    let (a, b) = (hash(b"image a"), hash(b"image b"));
    let payload = serde_json::json!({
        "id": "pulled", "vaultId": w.vault_id(), "title": "Pulled",
        "scene": w.scene_with_sidecar(&a, &b), "folder": null, "icon": null,
        "ownerNoteId": null, "clock": { "device-peer": 1 }, "deletedAt": null,
    });
    let record = memry_core::storage::repositories::sync_items::InboundRecord {
        item_type: "canvas".to_owned(),
        item_id: "pulled".to_owned(),
        payload_json: payload.to_string(),
        server_cursor: Some(1),
        signer_device_id: Some("device-peer".to_owned()),
        updated_at: NOW,
        deleted_at: None,
    };
    memry_core::sync::apply::apply_inbound(&w.data_db(), &record, NOW).unwrap();

    w.open_and_save("pulled", &w.scene_with_two_images(&a, &b));

    let saved = w.file(&saved_path(&w, "pulled"));
    assert_eq!(hashes(&sidecar(&saved)), vec![a.clone(), b.clone()]);
    let pushed = w.queued_scene("pulled").expect("the save is queued");
    assert_eq!(hashes(&sidecar(&pushed)), vec![a, b]);
}

#[test]
fn a_conflict_copy_keeps_the_sidecar_of_the_drawing_found_on_disk() {
    let w = world();
    let id = w.create("Board", None, "a").canvas.summary.id;
    let read = w.canvases.get(&id).unwrap().unwrap().sha256;
    let (a, b) = (hash(b"image a"), hash(b"image b"));
    // Another device's save landed in the document after this reader read it.
    let meta = memry_core::domain::canvas::file_format::FileMeta {
        id: id.clone(),
        created_at: NOW,
        updated_at: NOW,
    };
    fs::write(
        w.vault.join("canvases/Board.excalidraw"),
        memry_core::domain::canvas::file_format::with_file_meta(
            &w.scene_with_sidecar(&a, &b),
            &meta,
        ),
    )
    .unwrap();

    let input = CanvasUpdateInput {
        id: id.clone(),
        scene: Some(super::canvas_service::scene("mine")),
        expected_sha256: read,
        ..CanvasUpdateInput::default()
    };
    let Update::Saved {
        conflict_copy: Some(copy),
        ..
    } = w.canvases.update(&input, NOW + 10).unwrap()
    else {
        panic!("a conflict copy");
    };
    let copy_id = copy.canvas.summary.id;
    assert_eq!(
        hashes(&sidecar(&copy.canvas.scene)),
        vec![a.clone(), b.clone()]
    );
    assert_eq!(
        hashes(&sidecar(&w.file(&saved_path(&w, &copy_id)))),
        vec![a.clone(), b.clone()]
    );
    let mut rows = w.rows(&copy_id);
    rows.sort();
    let mut expected = vec![a, b];
    expected.sort();
    assert_eq!(rows, expected, "the copy's images are recorded for it");
}

#[test]
fn a_save_with_no_read_stamp_still_carries_the_sidecar() {
    let w = world();
    let id = w.create("Board", None, "a").canvas.summary.id;
    let shown = hash(PNG);
    w.record(&id, &shown, "f1", &format!("{shown}.png"));

    let input = CanvasUpdateInput {
        id: id.clone(),
        scene: Some(w.scene_with_image("f1", &format!("{shown}.png"))),
        expected_sha256: None,
        ..CanvasUpdateInput::default()
    };
    w.canvases.update(&input, NOW + 10).unwrap();

    assert_eq!(hashes(&sidecar(&w.scene_of(&id))), vec![shown.clone()]);
    assert_eq!(
        hashes(&sidecar(&w.queued_scene(&id).expect("queued"))),
        vec![shown]
    );
}
