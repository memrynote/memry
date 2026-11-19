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
