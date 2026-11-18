//! `deleted_asset_releases`: the stored assets of items this device deleted,
//! waiting out the grace period before their server chunks are freed
//! (`deleted-asset-release.ts`, #3015). One row per (item type, item id),
//! written by the device that raised the delete, before the item's own row
//! goes. The row outlives restarts, so the grace period runs from the delete.
//!
//! `attachment_ids` is a JSON array of strings: a note's references and own
//! file, or a never-filed inbox capture's one file, captured at delete time.
//! A canvas keeps its asset rows after its soft delete, so its column is
//! `NULL`. A desktop inbox delete goes through the core inbox domain
//! (`inbox_attachment_releases`); `inbox` rows here come from the Electron
//! import (#3553).
//!
//! The grace cutoff is the caller's (`plan::release_is_due` owns the 30 days),
//! so this module compares times and decides nothing.

use std::collections::BTreeSet;

use rusqlite::{Connection, params};

use super::failed;
use crate::api::errors::StorageError;

/// The `item_type` column.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum ItemType {
    Note,
    Canvas,
    Inbox,
}

impl ItemType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Note => "note",
            Self::Canvas => "canvas",
            Self::Inbox => "inbox",
        }
    }

    fn parse(raw: &str) -> Option<Self> {
        [Self::Note, Self::Canvas, Self::Inbox]
            .into_iter()
            .find(|item_type| item_type.as_str() == raw)
    }
}

/// The `attachment_ids` column, read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecordedIds {
    /// `NULL`: a canvas, whose asset rows say what it holds.
    None,
    Ids(Vec<String>),
    /// Not a JSON array of strings. Nothing of the row may be freed: the
    /// runner reports it and leaves the row.
    Unreadable,
}

impl RecordedIds {
    fn parse(raw: Option<String>) -> Self {
        match raw {
            None => Self::None,
            Some(text) => serde_json::from_str(&text).map_or(Self::Unreadable, Self::Ids),
        }
    }
}

/// One recorded delete.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeletedItem {
    /// The column as stored. A type no build writes stays visible as `Err`
    /// with its text, so the runner can report it; nothing of it is freed.
    pub item_type: Result<ItemType, String>,
    pub item_id: String,
    pub deleted_at: i64,
    pub attachment_ids: RecordedIds,
}

/// Records a delete this device raised (`recordDeletedItemAssets`, the write
/// half), replacing an earlier record of the same item: the grace period
/// restarts at `deleted_at`.
pub fn record(
    conn: &Connection,
    item_type: ItemType,
    item_id: &str,
    attachment_ids: Option<&[String]>,
    deleted_at: i64,
) -> Result<(), StorageError> {
    let ids = attachment_ids
        .map(serde_json::to_string)
        .transpose()
        .map_err(|err| StorageError::Failed {
            what: format!("could not encode attachment ids: {err}"),
        })?;
    conn.execute(
        "INSERT INTO deleted_asset_releases (item_type, item_id, deleted_at, attachment_ids)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (item_type, item_id) DO UPDATE SET
           deleted_at = excluded.deleted_at,
           attachment_ids = excluded.attachment_ids",
        params![item_type.as_str(), item_id, deleted_at, ids],
    )
    .map(|_| ())
    .map_err(failed)
}

/// Every record deleted at or before `cutoff_ms`, oldest first: the ones whose
/// grace period has passed when `cutoff_ms` is now minus the grace.
pub fn due(conn: &Connection, cutoff_ms: i64) -> Result<Vec<DeletedItem>, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT item_type, item_id, deleted_at, attachment_ids FROM deleted_asset_releases
             WHERE deleted_at <= ?1
             ORDER BY deleted_at, item_type, item_id",
        )
        .map_err(failed)?;
    statement
        .query_map(params![cutoff_ms], |row| {
            let raw_type: String = row.get(0)?;
            Ok(DeletedItem {
                item_type: ItemType::parse(&raw_type).ok_or(raw_type),
                item_id: row.get(1)?,
                deleted_at: row.get(2)?,
                attachment_ids: RecordedIds::parse(row.get(3)?),
            })
        })
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)
}

/// Settles a record: its chunks were freed, or nothing was left to free.
pub fn remove(conn: &Connection, item_type: &str, item_id: &str) -> Result<(), StorageError> {
    conn.execute(
        "DELETE FROM deleted_asset_releases WHERE item_type = ?1 AND item_id = ?2",
        params![item_type, item_id],
    )
    .map(|_| ())
    .map_err(failed)
}

/// The attachment ids of notes this device deleted after `cutoff_ms`, still
/// inside their grace period and so still restorable (`stillReferenced`). A
/// record whose ids cannot be read fails the call: what it holds is unknown,
/// so no release may run until it ages out.
pub fn held_by_recent_note_deletes(
    conn: &Connection,
    cutoff_ms: i64,
) -> Result<BTreeSet<String>, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT item_id, attachment_ids FROM deleted_asset_releases
             WHERE item_type = ?1 AND deleted_at > ?2",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map(params![ItemType::Note.as_str(), cutoff_ms], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })
        .map_err(failed)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(failed)?;
    let mut held = BTreeSet::new();
    for (item_id, raw) in rows {
        match RecordedIds::parse(raw) {
            RecordedIds::None => {}
            RecordedIds::Ids(ids) => held.extend(ids),
            RecordedIds::Unreadable => {
                return Err(StorageError::Failed {
                    what: format!("deleted note {item_id}: attachment_ids is not a list of ids"),
                });
            }
        }
    }
    Ok(held)
}
