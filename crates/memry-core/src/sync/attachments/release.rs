//! The deleted-asset release (#3535 S5, §14.8, `deleted-asset-release.ts`):
//! 30 days after this device deleted a note, canvas or unfiled inbox item, it
//! dereferences the item's server chunks unless something this device can see,
//! or still restore, names the same asset.
//!
//! Idempotent: a record goes only after the server confirmed every call, so a
//! pass cut off anywhere replays the same calls, and the server floors each
//! count at zero. The caller runs it hourly and only while the pull is caught
//! up: a stale local view misses a peer's new reference.

use std::collections::BTreeSet;
use std::sync::Arc;

use rusqlite::{Connection, OptionalExtension, params};

use super::holds::canvas_asset_holder_id;
use super::plan::{RELEASE_GRACE_MS, attachments_to_free, release_is_due};
use super::server::AttachmentServer;
use super::store::releases::{self, DeletedItem, ItemType, RecordedIds};
use crate::api::errors::StorageError;
use crate::domain::notes::read_attachment_references;
use crate::storage::Db;

/// One image row of a canvas (Step 30 owns the table).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanvasAsset {
    pub content_hash: String,
    pub attachment_id: String,
    pub chunk_hashes: Vec<String>,
}

/// What a live canvas, or one still inside its grace period, keeps.
#[derive(Debug, Clone, Default)]
pub struct CanvasKept {
    pub content_hashes: BTreeSet<String>,
    pub attachment_ids: BTreeSet<String>,
}

/// The canvas asset rows, which Step 30 (#3547) owns. Without a source a
/// canvas record stays, since nothing here can tell what it holds.
pub trait CanvasAssets: Send + Sync {
    /// The canvas is live again (a peer's edit beat the delete).
    fn is_live(&self, conn: &Connection, canvas_id: &str) -> Result<bool, StorageError>;
    fn assets(&self, conn: &Connection, canvas_id: &str) -> Result<Vec<CanvasAsset>, StorageError>;
    /// What every live canvas, and every canvas deleted after
    /// `grace_start_ms`, names: its scene and its rows.
    fn kept(&self, conn: &Connection, grace_start_ms: i64) -> Result<CanvasKept, StorageError>;
    /// The deleted canvas's chunks are freed: drop or move its rows.
    fn settle(
        &self,
        conn: &Connection,
        canvas_id: &str,
        freed: &[CanvasAsset],
    ) -> Result<(), StorageError>;
}

/// Records a note delete this device raised, before the note's row goes
/// (`recordDeletedItemAssets`). A note with no attachment records nothing.
pub fn record_deleted_note(
    conn: &Connection,
    note_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    let mut ids = read_attachment_references(conn, note_id)?;
    let own: Option<String> = conn
        .query_row(
            "SELECT attachment_id FROM notes WHERE id = ?1",
            params![note_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(failed)?
        .flatten();
    ids.extend(own);
    let ids: Vec<String> = ids
        .into_iter()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    if ids.is_empty() {
        return Ok(());
    }
    releases::record(conn, ItemType::Note, note_id, Some(&ids), now_ms)
}

/// What one release pass did.
#[derive(Debug, Default)]
pub struct ReleaseReport {
    pub settled: usize,
    /// Records left for the next pass, with the reason.
    pub deferred: Vec<String>,
}

/// Frees every recorded delete whose grace period has passed
/// (`releaseExpiredDeletedAssets`).
pub async fn release_due(
    db: &Db,
    server: AttachmentServer<'_>,
    canvases: Option<Arc<dyn CanvasAssets>>,
    now_ms: i64,
) -> Result<ReleaseReport, StorageError> {
    let grace_start = now_ms.saturating_sub(RELEASE_GRACE_MS);
    let due = db
        .call(move |conn| releases::due(conn, grace_start))
        .await?;
    let mut report = ReleaseReport::default();
    if due.is_empty() {
        return Ok(report);
    }
    let source = canvases.clone();
    let kept = db
        .call(move |conn| still_referenced(conn, source.as_deref(), grace_start))
        .await?;
    for item in due {
        let name = format!("{}:{}", type_name(&item), item.item_id);
        if !release_is_due(item.deleted_at, now_ms) {
            continue;
        }
        match release_one(db, server, canvases.as_ref(), &item, &kept).await {
            Ok(()) => {
                let (kind, id) = (type_name(&item).to_owned(), item.item_id.clone());
                db.call(move |conn| releases::remove(conn, &kind, &id))
                    .await?;
                report.settled += 1;
            }
            Err(reason) => {
                eprintln!("memry-core: release of {name} deferred: {reason}");
                report.deferred.push(format!("{name}: {reason}"));
            }
        }
    }
    Ok(report)
}

fn type_name(item: &DeletedItem) -> &str {
    match &item.item_type {
        Ok(item_type) => item_type.as_str(),
        Err(raw) => raw,
    }
}

/// Every attachment id a live note, a note this device deleted inside the
/// grace period, or a kept canvas names (`stillReferenced`).
fn still_referenced(
    conn: &Connection,
    canvases: Option<&dyn CanvasAssets>,
    grace_start: i64,
) -> Result<CanvasKept, StorageError> {
    let mut kept = match canvases {
        Some(source) => source.kept(conn, grace_start)?,
        None => CanvasKept::default(),
    };
    let mut statement = conn
        .prepare("SELECT id, attachment_id FROM notes WHERE deleted_at IS NULL")
        .map_err(failed)?;
    let notes = statement
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get(1)?)))
        .map_err(failed)?
        .collect::<Result<Vec<(String, Option<String>)>, _>>()
        .map_err(failed)?;
    for (id, own) in notes {
        kept.attachment_ids
            .extend(read_attachment_references(conn, &id)?);
        kept.attachment_ids.extend(own);
    }
    kept.attachment_ids
        .extend(releases::held_by_recent_note_deletes(conn, grace_start)?);
    Ok(kept)
}

async fn release_one(
    db: &Db,
    server: AttachmentServer<'_>,
    canvases: Option<&Arc<dyn CanvasAssets>>,
    item: &DeletedItem,
    kept: &CanvasKept,
) -> Result<(), String> {
    let item_type = item
        .item_type
        .clone()
        .map_err(|raw| format!("unknown item type {raw}"))?;
    let ids = match &item.attachment_ids {
        RecordedIds::Ids(ids) => ids.clone(),
        RecordedIds::None => Vec::new(),
        RecordedIds::Unreadable => return Err("attachment_ids is not a list of ids".into()),
    };
    match item_type {
        ItemType::Note => {
            let id = item.item_id.clone();
            let live = db
                .call(move |conn| note_is_live(conn, &id))
                .await
                .map_err(|e| e.to_string())?;
            free(
                server,
                &attachments_to_free(&ids, live, &kept.attachment_ids),
            )
            .await
        }
        ItemType::Inbox => {
            free(
                server,
                &attachments_to_free(&ids, false, &kept.attachment_ids),
            )
            .await
        }
        ItemType::Canvas => {
            let source = canvases.ok_or("no canvas asset source is registered")?;
            release_canvas(db, server, source.clone(), &item.item_id, kept).await
        }
    }
}

/// `releaseCanvas`: the deleted canvas drops its holds on every image first
/// (§14.8.1), then the images nothing else names are dereferenced.
async fn release_canvas(
    db: &Db,
    server: AttachmentServer<'_>,
    source: Arc<dyn CanvasAssets>,
    canvas_id: &str,
    kept: &CanvasKept,
) -> Result<(), String> {
    let (reader, id) = (source.clone(), canvas_id.to_owned());
    let state = db
        .call(move |conn| {
            Ok(match reader.is_live(conn, &id)? {
                true => None,
                false => Some(reader.assets(conn, &id)?),
            })
        })
        .await
        .map_err(|e| e.to_string())?;
    let Some(assets) = state else {
        return Ok(());
    };
    let holders = assets
        .iter()
        .map(|asset| canvas_asset_holder_id(server.vault_key, canvas_id, &asset.content_hash))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    server
        .release_holds(&holders)
        .await
        .map_err(|e| format!("hold release: {e}"))?;
    let freed: Vec<CanvasAsset> = assets
        .into_iter()
        .filter(|asset| {
            !kept.content_hashes.contains(&asset.content_hash)
                && !kept.attachment_ids.contains(&asset.attachment_id)
        })
        .collect();
    let chunks: Vec<String> = freed.iter().flat_map(|a| a.chunk_hashes.clone()).collect();
    if !chunks.is_empty() {
        server
            .dereference(&chunks)
            .await
            .map_err(|e| format!("dereference: {e}"))?;
    }
    let id = canvas_id.to_owned();
    db.call(move |conn| source.settle(conn, &id, &freed))
        .await
        .map_err(|e| e.to_string())
}

/// Dereferences the chunks of `ids`. An id with no manifest has nothing left.
async fn free(server: AttachmentServer<'_>, ids: &[String]) -> Result<(), String> {
    let mut chunks = Vec::new();
    for id in ids {
        match server.chunk_hashes(id).await {
            Ok(hashes) => chunks.extend(hashes.unwrap_or_default()),
            Err(error) => return Err(format!("manifest of {id}: {error}")),
        }
    }
    if chunks.is_empty() {
        return Ok(());
    }
    server
        .dereference(&chunks)
        .await
        .map_err(|e| format!("dereference: {e}"))
}

fn note_is_live(conn: &Connection, note_id: &str) -> Result<bool, StorageError> {
    conn.query_row(
        "SELECT 1 FROM notes WHERE id = ?1 AND deleted_at IS NULL",
        params![note_id],
        |_| Ok(()),
    )
    .optional()
    .map(|row| row.is_some())
    .map_err(failed)
}

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}
