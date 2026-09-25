//! Inbox reads: the list, archived, snoozed, filing history, duplicates and
//! the few counts the chrome shows (`apps/desktop/src/main/inbox/queries.ts`,
//! `snooze.ts`, `duplicates.ts`, `stats.ts`).
//!
//! Every read skips tombstoned rows (`deleted_at`), which is what desktop's
//! hard delete looks like from here.

use rusqlite::{Connection, params};
use sha2::{Digest as _, Sha256};

use crate::api::errors::StorageError;
use crate::domain::notes::failed;

use super::{COLUMNS, InboxItem, select_items};

/// `handleList`: unfiled, unarchived and (unless `include_snoozed`) not
/// snoozed, newest first.
pub fn list_active(
    conn: &Connection,
    include_snoozed: bool,
) -> Result<Vec<InboxItem>, StorageError> {
    let snooze = if include_snoozed {
        ""
    } else {
        "AND snoozed_until IS NULL"
    };
    select_items(
        conn,
        &format!(
            "SELECT {COLUMNS} FROM inbox_view
              WHERE deleted_at IS NULL AND filed_at IS NULL AND archived_at IS NULL {snooze}
              ORDER BY created_at DESC, id"
        ),
        &[],
    )
}

/// Active captures per type (`handleGetStats().itemsByType`), every known
/// type present, zero included, in the filter menu's order; a type a newer
/// build wrote is appended.
pub fn type_counts(conn: &Connection) -> Result<Vec<(String, i64)>, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT type, count(*) FROM inbox_items
              WHERE deleted_at IS NULL AND filed_at IS NULL AND snoozed_until IS NULL
                AND archived_at IS NULL
              GROUP BY type",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(failed)?;
    let found: Vec<(String, i64)> = rows.collect::<Result<_, _>>().map_err(failed)?;
    let mut counts: Vec<(String, i64)> = super::ITEM_TYPES
        .iter()
        .map(|kind| {
            let count = found.iter().find(|(t, _)| t == kind).map_or(0, |(_, n)| *n);
            ((*kind).to_owned(), count)
        })
        .collect();
    for (kind, count) in found {
        if !super::ITEM_TYPES.contains(&kind.as_str()) {
            counts.push((kind, count));
        }
    }
    Ok(counts)
}

/// `handleListArchived`: archived rows, most recently archived first, with
/// desktop's `LIKE %search%` over title and content.
pub fn archived(
    conn: &Connection,
    search: Option<&str>,
    limit: i64,
    offset: i64,
) -> Result<Vec<InboxItem>, StorageError> {
    let pattern = search
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| format!("%{s}%"));
    select_items(
        conn,
        &format!(
            "SELECT {COLUMNS} FROM inbox_view
              WHERE deleted_at IS NULL AND archived_at IS NOT NULL
                AND (?1 IS NULL OR title LIKE ?1 OR content LIKE ?1)
              ORDER BY archived_at DESC, id
              LIMIT ?2 OFFSET ?3"
        ),
        &[&pattern, &limit, &offset],
    )
}

/// `getSnoozedItems`: every snoozed, unfiled capture, soonest first. Past-due
/// ones are included, as on desktop (the scheduler surfaces them).
pub fn snoozed(conn: &Connection) -> Result<Vec<InboxItem>, StorageError> {
    select_items(
        conn,
        &format!(
            "SELECT {COLUMNS} FROM inbox_view
              WHERE deleted_at IS NULL AND snoozed_until IS NOT NULL AND filed_at IS NULL
              ORDER BY snoozed_until, id"
        ),
        &[],
    )
}

/// `getDueSnoozeItems`: snoozed, unfiled captures whose time has come.
pub fn due_snoozed(conn: &Connection, now_ms: i64) -> Result<Vec<InboxItem>, StorageError> {
    select_items(
        conn,
        &format!(
            "SELECT {COLUMNS} FROM inbox_view
              WHERE deleted_at IS NULL AND snoozed_until IS NOT NULL
                AND snoozed_until <= ?1 AND filed_at IS NULL
              ORDER BY snoozed_until, id"
        ),
        &[&now_ms],
    )
}

/// Active `reminder` captures (the reminder panel's Past source).
pub fn reminder_items(conn: &Connection) -> Result<Vec<InboxItem>, StorageError> {
    select_items(
        conn,
        &format!(
            "SELECT {COLUMNS} FROM inbox_view
              WHERE deleted_at IS NULL AND type = 'reminder'
                AND filed_at IS NULL AND archived_at IS NULL
              ORDER BY created_at DESC, id"
        ),
        &[],
    )
}

/// `handleGetFilingHistory`: filed captures, most recently filed first.
pub fn filing_history(conn: &Connection, limit: i64) -> Result<Vec<InboxItem>, StorageError> {
    select_items(
        conn,
        &format!(
            "SELECT {COLUMNS} FROM inbox_view
              WHERE deleted_at IS NULL AND filed_at IS NOT NULL
              ORDER BY filed_at DESC, id
              LIMIT ?1"
        ),
        &[&limit],
    )
}

/// `countReviewableInboxItems`: the review nudge's count and the entry badge.
/// Active captures, minus reminder captures already viewed.
pub fn reviewable_count(conn: &Connection) -> Result<i64, StorageError> {
    conn.query_row(
        "SELECT count(*) FROM inbox_view
          WHERE deleted_at IS NULL AND filed_at IS NULL AND snoozed_until IS NULL
            AND archived_at IS NULL AND (type != 'reminder' OR viewed_at_raw IS NULL)",
        [],
        |row| row.get(0),
    )
    .map_err(failed)
}

/// Active captures whose link metadata is still being fetched (the list
/// subtitle's "N fetching").
pub fn fetching_count(conn: &Connection) -> Result<i64, StorageError> {
    conn.query_row(
        "SELECT count(*) FROM inbox_view
          WHERE deleted_at IS NULL AND filed_at IS NULL AND archived_at IS NULL
            AND processing_status IN ('pending', 'processing')",
        [],
        |row| row.get(0),
    )
    .map_err(failed)
}

/// Folders captures were recently filed to, most recent first, deduplicated:
/// the parent of each `folder`-filed `filedTo` path, `""` for the vault root.
///
/// Desktop's suggestion fallback reads its local `filing_history` table
/// (`getRecentFilingDestinations`), which never syncs; the filed rows that
/// do sync carry the same destinations.
pub fn recent_folders(conn: &Connection, limit: usize) -> Result<Vec<String>, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT filed_to FROM inbox_items
              WHERE deleted_at IS NULL AND filed_action = 'folder' AND filed_to IS NOT NULL
              ORDER BY filed_at DESC",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(failed)?;
    let mut folders: Vec<String> = Vec::new();
    for row in rows {
        let path = row.map_err(failed)?;
        let folder = path.rsplit_once('/').map_or("", |(dir, _)| dir).to_owned();
        if !folders.contains(&folder) {
            folders.push(folder);
            if folders.len() == limit {
                break;
            }
        }
    }
    Ok(folders)
}

/// A capture that already holds this URL (`findDuplicateByUrl`): an exact
/// `sourceUrl` match among unfiled, unarchived captures.
pub fn duplicate_by_url(conn: &Connection, url: &str) -> Result<Option<InboxItem>, StorageError> {
    Ok(select_items(
        conn,
        &format!(
            "SELECT {COLUMNS} FROM inbox_view
              WHERE deleted_at IS NULL AND source_url = ?1
                AND filed_at IS NULL AND archived_at IS NULL
              ORDER BY created_at, id LIMIT 1"
        ),
        &[&url],
    )?
    .into_iter()
    .next())
}

/// Desktop's content fingerprint: sha256 of the first 500 characters.
fn content_hash(content: &str) -> Vec<u8> {
    let head: String = content.chars().take(CONTENT_HASH_LENGTH).collect();
    Sha256::digest(head.as_bytes()).to_vec()
}

/// `CONTENT_HASH_LENGTH` in `duplicates.ts`. JavaScript's `slice(0, 500)`
/// counts UTF-16 units; this counts scalar values, which differs only past
/// the 500th unit of text holding astral characters.
const CONTENT_HASH_LENGTH: usize = 500;

/// A text capture with the same opening (`findDuplicateByContent`): only for
/// content of 20 characters or more, among unfiled, unarchived `note` captures.
pub fn duplicate_by_content(
    conn: &Connection,
    content: &str,
) -> Result<Option<InboxItem>, StorageError> {
    if content.encode_utf16().count() < 20 {
        return Ok(None);
    }
    let target = content_hash(content);
    let candidates = select_items(
        conn,
        &format!(
            "SELECT {COLUMNS} FROM inbox_view
              WHERE deleted_at IS NULL AND type = 'note'
                AND filed_at IS NULL AND archived_at IS NULL
              ORDER BY created_at, id"
        ),
        &[],
    )?;
    Ok(candidates.into_iter().find(|candidate| {
        candidate
            .content
            .as_deref()
            .is_some_and(|text| !text.is_empty() && content_hash(text) == target)
    }))
}

/// Ids of live captures, for callers that re-read after a bulk write.
pub fn exists(conn: &Connection, item_id: &str) -> Result<bool, StorageError> {
    conn.query_row(
        "SELECT count(*) FROM inbox_items WHERE id = ?1 AND deleted_at IS NULL",
        params![item_id],
        |row| row.get::<_, i64>(0),
    )
    .map(|n| n > 0)
    .map_err(failed)
}
