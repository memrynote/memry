//! An edit outside the app to a vault file's frontmatter `tags:`, taken into the record of the
//! note or journal day the file is (desktop, #3825). The vault tier asks here once the file's
//! text reached the document, for bytes the app did not write; nothing here reads a file.
//!
//! - **A note's file owns its header tags**, as on desktop, where an edit in the app writes
//!   them into the file with the record and a push reads them from the file
//!   (`buildNotePushPayload`). The record takes the file's list through [`tags::set`]: case
//!   variants collapse to the first spelling, a pin on a dropped tag goes, and a list the record
//!   already holds writes nothing, so a body edit queues no push.
//! - **A journal day's record owns its tags** (decision on #3530: the app never writes a day's
//!   tags into its file, and keeps the file's `tags:` as the author wrote them), so the file's
//!   list is not the day's. What the edit changed in that list, against the list the file had
//!   before, is applied to the record: a tag the author added joins it, one they removed
//!   leaves it, and the tags only the record holds stay. A respelling in the file changes
//!   nothing (same tag, §13.7.7).
//!
//!   The list the file had is the day's **baseline**: the last list this device read in, or
//!   wrote into, the day's file ([`seen`]: a found file, a file the app made, every take),
//!   kept on this device only, in `meta` (`journal.file_tags:<id>`; an older build ignores the
//!   key, so no migration). A file whose frontmatter does not parse never reaches here, so a
//!   half-typed list leaves the baseline as it was. A day with no baseline (found or made by
//!   an older build) falls back to the index's measure of the replaced file, when the caller
//!   has one; with neither, nothing is taken, since a guess would add back a tag the record
//!   dropped, or drop one only the record holds.
//!
//! A deleted or absent record takes nothing: its queued delete must not become an upsert.

use rusqlite::{Connection, OptionalExtension as _, params};

use crate::api::errors::StorageError;
use crate::domain::header_tags::{self, HeaderTagEdit};
use crate::domain::journal;
use crate::domain::journal_ops::metadata;
use crate::domain::tags;
use crate::storage::repositories::sync_items;

use super::{ITEM_TYPE, failed};

/// The `meta` key prefix of a day's baseline.
const BASELINE: &str = "journal.file_tags:";

/// Takes the file's header tags `after` into the record `id`; `indexed` is the index's measure
/// of the file the edit replaced, when it measured that file.
pub fn taken(
    conn: &Connection,
    id: &str,
    indexed: Option<&[String]>,
    after: &[String],
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    if let Some(date) = journal::date_of(conn, id)? {
        let tx = conn.unchecked_transaction().map_err(failed)?;
        let before = baseline(&tx, id)?.or_else(|| indexed.map(<[String]>::to_vec));
        if let Some(change) = before.and_then(|before| header_tags::compare(&before, after)) {
            let edit = HeaderTagEdit {
                add: change.added,
                remove: change.removed,
                ..HeaderTagEdit::default()
            };
            let next = header_tags::apply(&tags::list(&tx, journal::ITEM_TYPE, id)?, &edit);
            metadata::set_live_tags_in(&tx, &date, &next, device_id, now_ms)?;
        }
        record(&tx, id, after)?;
        return tx.commit().map_err(failed);
    }
    match sync_items::load(conn, ITEM_TYPE, id)? {
        Some(row) if row.deleted_at.is_none() => {
            tags::set(conn, ITEM_TYPE, id, after, device_id, now_ms)?;
            Ok(())
        }
        _ => Ok(()),
    }
}

/// The file of the record `id` says `tags`, as this device found it or wrote it: a day's
/// baseline. A note keeps none.
pub fn seen(conn: &Connection, id: &str, tags: &[String]) -> Result<(), StorageError> {
    if journal::date_of(conn, id)?.is_some() {
        record(conn, id, tags)?;
    }
    Ok(())
}

fn baseline(conn: &Connection, id: &str) -> Result<Option<Vec<String>>, StorageError> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM meta WHERE key = ?1",
            params![format!("{BASELINE}{id}")],
            |row| row.get(0),
        )
        .optional()
        .map_err(failed)?;
    // A value that does not read is no baseline: the fallback, or nothing, is taken instead.
    Ok(raw.and_then(|raw| serde_json::from_str(&raw).ok()))
}

fn record(conn: &Connection, id: &str, tags: &[String]) -> Result<(), StorageError> {
    let value = serde_json::to_string(tags).map_err(|error| StorageError::Failed {
        what: format!("a day's file tags will not serialise: {error}"),
    })?;
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![format!("{BASELINE}{id}"), value],
    )
    .map_err(failed)?;
    Ok(())
}
