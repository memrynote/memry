//! Inbox captures in search (#4320): `fts_inbox`. [`super::search`] queries
//! it as the inbox group.
//!
//! Desktop indexes every capture in `fts_inbox` (`fts-inbox.ts`) and ranks it
//! with `bm25(fts_inbox, 0.0, 3.0, 1.0, 1.0, 0.5)`. This does the same over
//! the `inbox_view` projection: the title, the text content, the voice memo's
//! `transcription` (read from the verbatim payload) and the link's source
//! title. Every live capture is indexed, filed, archived and snoozed ones
//! included, because a capture that left the list is still one the user may
//! look for.
//!
//! The table keeps its own watermark, read the way [`super::maintenance`]
//! reads the others: `inbox_items.synced_at` is this device's apply stamp, and
//! a missing watermark empties the table and fills it from every capture.

use std::collections::BTreeMap;

use rusqlite::{Connection, OptionalExtension as _, params};

use crate::api::errors::StorageError;

use super::failed;
use super::maintenance::{Reindexed, Stamps, merged, stamped};

/// `index_meta` key: the `fts_inbox` watermark.
pub const INBOX_WATERMARK_KEY: &str = "watermark.fts_inbox";
/// The `fts_inbox` ranking expression, desktop's weights.
pub const INBOX_RANK: &str = "bm25(fts_inbox, 0.0, 3.0, 1.0, 1.0, 0.5)";

/// Every capture whose projection row moved at or after `from`, with its
/// stamps.
pub(super) fn inbox_candidates(
    data: &Connection,
    from: i64,
) -> Result<BTreeMap<String, Stamps>, StorageError> {
    stamped(
        data,
        "SELECT id AS doc_id, synced_at AS stamp FROM inbox_items
           WHERE synced_at IS NULL OR synced_at >= ?1",
        params![from],
    )
}

/// [`inbox_candidates`]' stamps for one capture.
pub(super) fn inbox_stamps(data: &Connection, from: i64, id: &str) -> Result<Stamps, StorageError> {
    let stamps = stamped(
        data,
        "SELECT id, synced_at FROM inbox_items
           WHERE id = ?2 AND (synced_at IS NULL OR synced_at >= ?1)",
        params![from, id],
    )?;
    Ok(merged(stamps))
}

/// Re-indexes one capture: delete first, then insert if it is still live.
pub(super) fn index_item(
    data: &Connection,
    index: &Connection,
    id: &str,
    done: &mut Reindexed,
) -> Result<(), StorageError> {
    index
        .execute("DELETE FROM fts_inbox WHERE id = ?1", params![id])
        .map_err(failed)?;

    let record = data
        .query_row(
            "SELECT deleted_at, corrupt_reason FROM sync_items
             WHERE item_type = 'inbox' AND item_id = ?1",
            params![id],
            |row| {
                Ok((
                    row.get::<_, Option<i64>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                ))
            },
        )
        .optional()
        .map_err(failed)?;
    match record {
        None | Some((Some(_), _)) => {
            done.inbox_removed += 1;
            return Ok(());
        }
        Some((None, Some(_))) => {
            done.corrupt_skipped += 1;
            return Ok(());
        }
        Some((None, None)) => {}
    }

    // `inbox_view` joins the verbatim payload, so a record whose payload has
    // not been pulled yet has no row here. The fill bumps `synced_at`, so it
    // comes back as a candidate.
    let Some((title, content, transcription, source_title)) = data
        .query_row(
            "SELECT title, content, transcription, source_title FROM inbox_view
             WHERE id = ?1 AND deleted_at IS NULL",
            params![id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            },
        )
        .optional()
        .map_err(failed)?
    else {
        return Ok(());
    };
    index
        .execute(
            "INSERT INTO fts_inbox (id, title, content, transcription, source_title)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                id,
                title.unwrap_or_default(),
                content.unwrap_or_default(),
                transcription.unwrap_or_default(),
                source_title.unwrap_or_default(),
            ],
        )
        .map_err(failed)?;
    done.inbox_indexed += 1;
    Ok(())
}
