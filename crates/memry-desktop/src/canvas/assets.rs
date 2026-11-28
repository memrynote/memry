//! Canvas image assets: port of the local side of `canvas/assets/asset-service.ts`,
//! `asset-store.ts` and `memry-assets.ts`. An image a canvas shows is stored once per vault at
//! `attachments/canvas-assets/<sha256>.<ext>` and named in the scene by a `memry-file://` ref;
//! `canvas_assets` (device-local) records which canvas shows which image under which attachment.
//!
//! Every byte transfer and every server call (upload, download, holds, dereference) is 30f's: it
//! needs the Step 18 (#3535) attachment queue. Until then this device answers `canUpload: false`
//! (Electron's signed-out answer), so the editor keeps new images inline; an upload that would
//! need the server is refused ([`AssetError::UploadUnavailable`]) and writes nothing. Asset GC is
//! not run either: Electron prunes a row and unlinks its file only after the server released the
//! holds and dereferenced the chunks, so with no server call every row and file stays.
//!
//! A file is reached only through a row's `filename` of the form Electron writes,
//! `<64 hex>.<ext>`, inside a store folder that is a real directory of the vault, never a link
//! ([`AssetError::Escape`]).

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use memry_core::api::errors::StorageError;
use memry_core::domain::canvas::canonical_scene;
use memry_core::sync::attachments::plan::in_grace;
use rusqlite::{Connection, Row, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest as _, Sha256};

use super::service::CanvasService;
use crate::vault::fs_atomic::{WriteError, atomic_create};

const ATTACHMENTS_DIR: &str = "attachments";
const STORE_DIR: &str = "canvas-assets";
const MEMRY_FILE_PREFIX: &str = "memry-file://";
const STORE_MARKER: &str = "/canvas-assets/";
const SIDECAR_KEY: &str = "memryAssets";

/// `MemryAssetDescriptor`: one image a canvas shows, as the sidecar carries it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MemryAssetDescriptor {
    pub file_id: String,
    pub attachment_id: String,
    pub content_hash: String,
    pub chunk_hashes: Vec<String>,
    pub mime_type: String,
    pub size_bytes: i64,
    pub filename: String,
}

/// `canvas:upload-asset`'s input; the bytes come as Electron's `number[]`.
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CanvasUploadAssetInput {
    pub canvas_id: String,
    pub file_id: String,
    pub mime_type: String,
    pub data: Vec<u8>,
}

/// `CanvasUploadAssetResponse`.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct UploadedAsset {
    #[serde(rename = "ref")]
    pub reference: String,
    pub descriptor: MemryAssetDescriptor,
    pub deduped: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum AssetError {
    #[error(transparent)]
    Storage(#[from] StorageError),
    #[error(transparent)]
    Write(#[from] WriteError),
    /// New bytes need the attachment upload, which this build does not have yet (30f).
    #[error("canvas image upload is not available")]
    UploadUnavailable,
    /// The file named would sit outside the vault's canvas asset folder.
    #[error("a canvas image path leaves the canvas asset folder")]
    Escape,
}

impl CanvasService {
    /// `listCanvasAssetDescriptors`: every image recorded for a canvas.
    pub fn list_assets(&self, canvas_id: &str) -> Result<Vec<MemryAssetDescriptor>, StorageError> {
        let id = canvas_id.to_owned();
        self.canvases
            .db()
            .read_blocking(move |conn| rows(conn, &id))
    }

    /// `getCanvasAssetRef`: the `memry-file://` ref of one scene file id, `None` when no row
    /// names it or its file would sit outside the store.
    pub fn asset_ref(
        &self,
        canvas_id: &str,
        file_id: &str,
    ) -> Result<Option<String>, StorageError> {
        let Some(row) = self
            .list_assets(canvas_id)?
            .into_iter()
            .find(|row| row.file_id == file_id)
        else {
            return Ok(None);
        };
        Ok(store_file(&self.vault, &row.filename)
            .inspect_err(|_| refused_row())
            .ok()
            .map(|path| memry_file_url(&path)))
    }

    /// `uploadCanvasAsset` without the upload: bytes already recorded for a canvas whose chunks
    /// the server keeps are written once to the store and recorded for this canvas. New bytes
    /// are refused before anything is written.
    pub fn upload_asset(
        &self,
        input: &CanvasUploadAssetInput,
        now_ms: i64,
    ) -> Result<UploadedAsset, AssetError> {
        let content_hash = hex::encode(Sha256::digest(&input.data));
        let vault_id = self.canvases.vault_id().to_owned();
        let hash = content_hash.clone();
        let existing = self
            .canvases
            .db()
            .read_blocking(move |conn| dedup_source(conn, &vault_id, &hash, now_ms))?;
        let Some(existing) = existing else {
            return Err(AssetError::UploadUnavailable);
        };
        let path = store_file(&self.vault, &existing.filename).inspect_err(|_| refused_row())?;
        fs::create_dir_all(path.parent().unwrap_or(&self.vault)).map_err(|source| WriteError {
            path: path.clone(),
            source,
        })?;
        // The folder was created through whatever is on the path: check it again.
        store_file(&self.vault, &existing.filename)?;
        if fs::symlink_metadata(&path).is_err() {
            match atomic_create(&path, &input.data) {
                Err(error) if !error.already_exists() => return Err(error.into()),
                // Content-addressed: a file someone put there meanwhile is these bytes.
                _ => {}
            }
        }
        let descriptor = MemryAssetDescriptor {
            file_id: input.file_id.clone(),
            content_hash,
            ..existing
        };
        let vault_id = self.canvases.vault_id().to_owned();
        let canvas_id = input.canvas_id.clone();
        let row = descriptor.clone();
        self.write::<_, StorageError>(|conn| record(conn, &vault_id, &canvas_id, &row, now_ms))?;
        Ok(UploadedAsset {
            reference: memry_file_url(&path),
            descriptor,
            deduped: true,
        })
    }
}

/// `injectSceneAssetSidecar`: the scene with `memryAssets` set to the descriptors of the images
/// it shows, so a receiving device can restore them. An empty scene stays as it is.
pub(super) fn with_sidecar(
    conn: &Connection,
    canvas_id: &str,
    scene: &str,
) -> Result<String, StorageError> {
    let Ok(Value::Object(mut parsed)) = serde_json::from_str::<Value>(scene) else {
        return Ok(scene.to_owned());
    };
    let shown = shown_hashes(&parsed);
    let descriptors: Vec<_> = rows(conn, canvas_id)?
        .into_iter()
        .filter(|row| shown.contains(&row.content_hash))
        .collect();
    parsed.insert(SIDECAR_KEY.to_owned(), serde_json::json!(descriptors));
    canonical_scene(&Value::Object(parsed).to_string())
}

/// `extractSceneFileRefs` + `contentHashFromRef`: the content hash of each `files` entry whose
/// `dataURL` is a canvas-asset `memry-file://` ref.
fn shown_hashes(scene: &serde_json::Map<String, Value>) -> HashSet<String> {
    let Some(Value::Object(files)) = scene.get("files") else {
        return HashSet::new();
    };
    files
        .values()
        .filter_map(|file| file.get("dataURL")?.as_str())
        .filter(|url| url.starts_with(MEMRY_FILE_PREFIX) && url.contains(STORE_MARKER))
        .filter_map(|url| {
            let basename = url.rsplit('/').next().filter(|name| !name.is_empty())?;
            Some(match basename.rfind('.') {
                Some(dot) if dot > 0 => basename[..dot].to_owned(),
                _ => basename.to_owned(),
            })
        })
        .collect()
}

fn rows(conn: &Connection, canvas_id: &str) -> Result<Vec<MemryAssetDescriptor>, StorageError> {
    let mut stmt = conn
        .prepare(
            "SELECT file_id, attachment_id, content_hash, chunk_hashes, mime_type, size_bytes,
                    filename
             FROM canvas_assets WHERE canvas_id = ?1 ORDER BY rowid",
        )
        .map_err(failed)?;
    stmt.query_map([canvas_id], descriptor)
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)
}

/// `findAssetByContentHash`: a row whose chunks no release can have freed, that of a live
/// canvas or of one this device deleted that is still in its grace period.
fn dedup_source(
    conn: &Connection,
    vault_id: &str,
    content_hash: &str,
    now_ms: i64,
) -> Result<Option<MemryAssetDescriptor>, StorageError> {
    let mut stmt = conn
        .prepare(
            "SELECT a.file_id, a.attachment_id, a.content_hash, a.chunk_hashes, a.mime_type,
                    a.size_bytes, a.filename, c.deleted_at, r.deleted_at
             FROM canvas_assets a
             JOIN canvases c ON c.id = a.canvas_id
             LEFT JOIN deleted_asset_releases r
               ON r.item_type = 'canvas' AND r.item_id = a.canvas_id
             WHERE a.vault_id = ?1 AND a.content_hash = ?2
             ORDER BY a.rowid",
        )
        .map_err(failed)?;
    let mut found = stmt
        .query_map(params![vault_id, content_hash], |row| {
            let deleted: Option<i64> = row.get(7)?;
            let released: Option<i64> = row.get(8)?;
            let held = deleted.is_none() || released.is_some_and(|at| in_grace(at, now_ms));
            held.then(|| descriptor(row)).transpose()
        })
        .map_err(failed)?;
    found
        .find_map(|row| row.transpose())
        .transpose()
        .map_err(failed)
}

/// `recordAsset`: the (canvas, image) row; one already there is kept.
fn record(
    conn: &Connection,
    vault_id: &str,
    canvas_id: &str,
    row: &MemryAssetDescriptor,
    now_ms: i64,
) -> Result<(), StorageError> {
    let chunk_hashes =
        serde_json::to_string(&row.chunk_hashes).map_err(|error| StorageError::Failed {
            what: format!("canvas_assets: {error}"),
        })?;
    conn.execute(
        "INSERT OR IGNORE INTO canvas_assets (vault_id, canvas_id, content_hash, attachment_id,
             file_id, filename, mime_type, size_bytes, chunk_hashes, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            vault_id,
            canvas_id,
            row.content_hash,
            row.attachment_id,
            row.file_id,
            row.filename,
            row.mime_type,
            row.size_bytes,
            chunk_hashes,
            now_ms
        ],
    )
    .map_err(failed)?;
    Ok(())
}

fn descriptor(row: &Row<'_>) -> rusqlite::Result<MemryAssetDescriptor> {
    let chunk_hashes: String = row.get(3)?;
    Ok(MemryAssetDescriptor {
        file_id: row.get(0)?,
        attachment_id: row.get(1)?,
        content_hash: row.get(2)?,
        // A list Electron wrote as JSON; anything else names no chunk.
        chunk_hashes: serde_json::from_str(&chunk_hashes).unwrap_or_default(),
        mime_type: row.get(4)?,
        size_bytes: row.get(5)?,
        filename: row.get(6)?,
    })
}

/// The store path of `filename`, refused unless it is `<64 hex>.<ext>` (`assetFilename`) and
/// neither the store folder nor its parent nor the file is a link.
fn store_file(vault: &Path, filename: &str) -> Result<PathBuf, AssetError> {
    let named = filename.split_once('.').is_some_and(|(hash, ext)| {
        hash.len() == 64
            && hash
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            && matches!(ext, "png" | "jpg" | "gif" | "webp" | "svg" | "bin")
    });
    if !named {
        return Err(AssetError::Escape);
    }
    let attachments = vault.join(ATTACHMENTS_DIR);
    let store = attachments.join(STORE_DIR);
    let file = store.join(filename);
    for path in [&attachments, &store, &file] {
        if fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink()) {
            return Err(AssetError::Escape);
        }
    }
    Ok(file)
}

/// `toMemryFileUrl`: forward slashes, no leading `/`, nothing percent-encoded.
fn memry_file_url(path: &Path) -> String {
    let path = path.to_string_lossy().replace('\\', "/");
    format!("memry-file://local/{}", path.trim_start_matches('/'))
}

fn refused_row() {
    tracing::warn!(
        scope = "CanvasAssetService",
        "refusing a canvas image row that names a file outside the asset folder"
    );
}

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: format!("canvas_assets: {error}"),
    }
}
