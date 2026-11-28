//! A scene's `memryAssets` sidecar as `canvas_assets` rows: desktop's
//! `readMemryAssets` (`canvas/assets/memry-assets.ts`) and `recordSceneAssets`
//! (`sync/item-handlers/canvas-handler.ts:68`). The shell rebuilds the sidecar
//! of every save from these rows, so a canvas that arrives with a sidecar (an
//! adopted document, a pulled scene, a conflict copy) has to leave its rows
//! here, or its next save pushes `memryAssets: []` and no device can restore
//! its images again.

use rusqlite::{Connection, params};
use serde::Deserialize;
use serde_json::Value;

use crate::api::errors::StorageError;
use crate::domain::notes::failed;

const SIDECAR_KEY: &str = "memryAssets";

/// `MemryAssetDescriptor` as the sidecar carries it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Descriptor {
    file_id: String,
    attachment_id: String,
    content_hash: String,
    chunk_hashes: Vec<String>,
    mime_type: String,
    size_bytes: i64,
    filename: String,
}

/// Records one row per sidecar descriptor of `scene` for `canvas_id`. A row
/// already there is pointed at the descriptor's attachment, which a peer that
/// re-uploaded the image names (#3022). A scene with no sidecar, or one that is
/// not JSON, records nothing (a pre-asset, inline-image scene). An entry that
/// is not a whole descriptor is passed over: desktop's insert would refuse it
/// and abort the apply, and it names no image a device could restore.
pub(crate) fn record_scene_assets(
    conn: &Connection,
    vault_id: &str,
    canvas_id: &str,
    scene: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    let Ok(Value::Object(mut parsed)) = serde_json::from_str::<Value>(scene) else {
        return Ok(());
    };
    let Some(Value::Array(entries)) = parsed.remove(SIDECAR_KEY) else {
        return Ok(());
    };
    for entry in entries {
        let Ok(asset) = serde_json::from_value::<Descriptor>(entry) else {
            continue;
        };
        let chunk_hashes =
            serde_json::to_string(&asset.chunk_hashes).map_err(|error| StorageError::Failed {
                what: format!("canvas_assets: {error}"),
            })?;
        conn.execute(
            "INSERT INTO canvas_assets (vault_id, canvas_id, content_hash, attachment_id,
                 file_id, filename, mime_type, size_bytes, chunk_hashes, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT (canvas_id, content_hash) DO UPDATE SET
                 attachment_id = excluded.attachment_id, chunk_hashes = excluded.chunk_hashes",
            params![
                vault_id,
                canvas_id,
                asset.content_hash,
                asset.attachment_id,
                asset.file_id,
                asset.filename,
                asset.mime_type,
                asset.size_bytes,
                chunk_hashes,
                now_ms
            ],
        )
        .map_err(failed)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::storage::repositories::sync_items::{ApplyOutcome, InboundRecord};
    use crate::storage::{open_data, test_support::temp_dir};
    use crate::sync::apply::apply_inbound;

    const NOW: i64 = 1_760_000_000_000;

    fn descriptor(hash: &str, attachment: &str) -> Value {
        json!({ "fileId": "f1", "attachmentId": attachment, "contentHash": hash,
                "chunkHashes": ["c1"], "mimeType": "image/png", "sizeBytes": 3,
                "filename": format!("{hash}.png") })
    }

    fn pulled(sidecar: Value, tick: i64) -> InboundRecord {
        let scene = json!({ "elements": [], "files": {}, "memryAssets": sidecar }).to_string();
        InboundRecord {
            item_type: "canvas".to_owned(),
            item_id: "c1".to_owned(),
            payload_json: json!({ "id": "c1", "vaultId": "v1", "scene": scene,
                                  "clock": { "peer": tick } })
            .to_string(),
            server_cursor: Some(tick),
            signer_device_id: Some("peer".to_owned()),
            updated_at: NOW + tick,
            deleted_at: None,
        }
    }

    fn rows(conn: &Connection) -> Vec<(String, String)> {
        let mut stmt = conn
            .prepare("SELECT content_hash, attachment_id FROM canvas_assets ORDER BY content_hash")
            .unwrap();
        stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }

    #[test]
    fn a_pulled_sidecar_is_recorded_and_a_newer_one_repoints_its_rows() {
        let dir = temp_dir("canvas-scene-assets");
        let db = open_data(&dir.path().join("data.db")).unwrap();
        db.call_blocking(|conn| {
            let first = json!([descriptor("h1", "att-1"), { "contentHash": "partial" }]);
            assert_eq!(
                apply_inbound(conn, &pulled(first, 1), NOW)?,
                ApplyOutcome::Applied
            );
            assert_eq!(rows(conn), vec![("h1".to_owned(), "att-1".to_owned())]);

            let second = json!([descriptor("h1", "att-2"), descriptor("h2", "att-3")]);
            assert_eq!(
                apply_inbound(conn, &pulled(second, 2), NOW)?,
                ApplyOutcome::Applied
            );
            assert_eq!(
                rows(conn),
                vec![
                    ("h1".to_owned(), "att-2".to_owned()),
                    ("h2".to_owned(), "att-3".to_owned())
                ]
            );
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn a_sidecar_nested_past_the_parser_depth_records_nothing() {
        let deep = format!(
            r#"{{"memryAssets":{}{}}}"#,
            "[".repeat(100_000),
            "]".repeat(100_000)
        );
        std::thread::Builder::new()
            .stack_size(2 * 1024 * 1024)
            .spawn(move || {
                let dir = temp_dir("canvas-scene-assets-deep");
                let db = open_data(&dir.path().join("data.db")).unwrap();
                db.call_blocking(|conn| {
                    record_scene_assets(conn, "v1", "c1", &deep, NOW)?;
                    assert!(rows(conn).is_empty());
                    Ok(())
                })
                .unwrap();
            })
            .unwrap()
            .join()
            .unwrap();
    }
}
