//! The local attachment cache and what connects a note to it (N203, N204).
//!
//! The `attachments` table is data-model §A.4's: one row per attachment id,
//! carrying the decrypted manifest, the notes that reference it, and where the
//! bytes are once they have arrived.
//!
//! ## Two rules here are protocol, not policy
//!
//! **An absent `attachmentReferences` means "this sender does not know", never
//! "this note has no attachments"** (§14.7, chapter 13 §13.4). The field is
//! `.nullable().optional()`, so an older client pushing a note it edited omits
//! it entirely. [`merge_note_references`] therefore takes an `Option` and
//! **does nothing at all** when it is `None` — it does not clear the local
//! list. Treating absence as emptiness would delete a note's pictures from
//! this device's view because a different device did not mention them.
//!
//! **Quota is reserved against ciphertext size, not plaintext** (§14.8), so
//! `remote_size` is the ciphertext figure and the cache budget is measured in
//! it. A cache sized against `manifest.size` under-counts by a nonce and a tag
//! per chunk.
//!
//! ## Eviction, and the one thing the core cannot do
//!
//! **Eviction clears `local_path` and never removes a row, and never touches a
//! pinned row** (data-model §A.4). The row is what remembers the manifest and
//! the note references; deleting it would turn an evicted picture into an
//! unknown one.
//!
//! The core does not own the sandbox directory, so it cannot unlink the file.
//! [`evict_to_budget`] clears the column and **returns the paths for the shell
//! to delete**. If the shell dies in between, the bytes are orphaned on disk
//! while the row says "not downloaded", so a later download rewrites the file
//! rather than corrupting anything — a disk-space leak, not a data fault, and
//! [`orphan_candidates`] is how a sweep reclaims it.

use rusqlite::{Connection, OptionalExtension as _};

use crate::api::errors::StorageError;
use crate::seams::reachability::Reachable;

/// One cached attachment.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct CachedAttachment {
    pub attachment_id: String,
    /// The decrypted manifest JSON, verbatim.
    ///
    /// Stored as the bytes it arrived as rather than as parsed columns,
    /// because §14.4's field set may grow and a column per field would drop
    /// whatever this build does not know (FR-033).
    pub manifest: Option<String>,
    /// Note ids referencing this attachment.
    pub note_refs: Vec<String>,
    /// **Ciphertext** size, which is what quota is reserved against (§14.8).
    pub remote_size: Option<i64>,
    /// Relative to the shell's `images/` directory. `None` until downloaded,
    /// and `None` again after eviction.
    pub local_path: Option<String>,
    pub downloaded_at: Option<i64>,
    /// FR-045's per-item override. `true` by default: bytes wait for an
    /// unmetered path unless the user asked for this one specifically.
    pub unmetered_only: bool,
    /// Exempt from eviction.
    pub pinned: bool,
    pub filename: Option<String>,
    pub mime_type: Option<String>,
}

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

fn read_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<CachedAttachment> {
    let refs: Option<String> = row.get("note_refs")?;
    Ok(CachedAttachment {
        attachment_id: row.get("attachment_id")?,
        manifest: row.get("manifest")?,
        note_refs: refs
            .as_deref()
            .and_then(|json| serde_json::from_str::<Vec<String>>(json).ok())
            .unwrap_or_default(),
        remote_size: row.get("remote_size")?,
        local_path: row.get("local_path")?,
        downloaded_at: row.get("downloaded_at")?,
        unmetered_only: row.get::<_, i64>("unmetered_only")? != 0,
        pinned: row.get::<_, i64>("pinned")? != 0,
        filename: row.get("filename")?,
        mime_type: row.get("mime_type")?,
    })
}

const COLUMNS: &str = "attachment_id, manifest, note_refs, remote_size, local_path, \
                       downloaded_at, unmetered_only, pinned, filename, mime_type";

/// One attachment by id, or `None` when this device has never heard of it.
pub fn get(
    conn: &Connection,
    attachment_id: &str,
) -> Result<Option<CachedAttachment>, StorageError> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM attachments WHERE attachment_id = ?1"),
        rusqlite::params![attachment_id],
        read_row,
    )
    .optional()
    .map_err(failed)
}

/// Records a manifest this device has fetched and opened.
///
/// Upsert rather than insert: a manifest is re-fetched when a note is opened
/// on a device that evicted the bytes, and the row's `pinned` and
/// `unmetered_only` are the **user's** settings and must survive that.
pub fn put_manifest(
    conn: &Connection,
    attachment_id: &str,
    manifest_json: &str,
    remote_size: i64,
    filename: &str,
    mime_type: &str,
) -> Result<(), StorageError> {
    conn.execute(
        "INSERT INTO attachments \
           (attachment_id, manifest, remote_size, filename, mime_type, note_refs) \
         VALUES (?1, ?2, ?3, ?4, ?5, COALESCE((SELECT note_refs FROM attachments WHERE attachment_id = ?1), '[]')) \
         ON CONFLICT(attachment_id) DO UPDATE SET \
           manifest = excluded.manifest, \
           remote_size = excluded.remote_size, \
           filename = excluded.filename, \
           mime_type = excluded.mime_type",
        rusqlite::params![attachment_id, manifest_json, remote_size, filename, mime_type],
    )
    .map_err(failed)?;
    Ok(())
}

/// Records that the bytes are on disk.
pub fn record_download(
    conn: &Connection,
    attachment_id: &str,
    local_path: &str,
    downloaded_at: i64,
) -> Result<(), StorageError> {
    conn.execute(
        "UPDATE attachments SET local_path = ?2, downloaded_at = ?3 WHERE attachment_id = ?1",
        rusqlite::params![attachment_id, local_path, downloaded_at],
    )
    .map_err(failed)?;
    Ok(())
}

/// FR-045's explicit per-item override.
pub fn set_unmetered_only(
    conn: &Connection,
    attachment_id: &str,
    unmetered_only: bool,
) -> Result<(), StorageError> {
    conn.execute(
        "UPDATE attachments SET unmetered_only = ?2 WHERE attachment_id = ?1",
        rusqlite::params![attachment_id, i64::from(unmetered_only)],
    )
    .map_err(failed)?;
    Ok(())
}

/// Marks a row exempt from eviction.
pub fn set_pinned(
    conn: &Connection,
    attachment_id: &str,
    pinned: bool,
) -> Result<(), StorageError> {
    conn.execute(
        "UPDATE attachments SET pinned = ?2 WHERE attachment_id = ?1",
        rusqlite::params![attachment_id, i64::from(pinned)],
    )
    .map_err(failed)?;
    Ok(())
}

/// FR-045's metered policy: whether these bytes may be fetched right now.
///
/// A pure function of the row and the path, so the decision is testable
/// without a network and cannot drift between callers.
///
/// `Cellular` is the only interesting case. `Offline` is never a download, and
/// on `Wifi` the override is irrelevant — the setting says "not on metered
/// data", not "only when I ask".
pub fn may_download(attachment: &CachedAttachment, reachable: Reachable) -> bool {
    match reachable {
        Reachable::Offline => false,
        Reachable::Wifi => true,
        Reachable::Cellular => !attachment.unmetered_only,
    }
}

// MARK: - N204, what connects a note to a manifest

/// Merges a note's `attachmentReferences` into the cache.
///
/// **`None` does nothing** (§14.7). The field is nullable and optional, so a
/// client that does not know about attachments pushes a note without it, and
/// clearing the local list on that would delete a note's pictures from this
/// device because another device stayed quiet. `Some(vec![])` is different and
/// does clear: that sender knows, and says there are none.
pub fn merge_note_references(
    conn: &Connection,
    note_id: &str,
    references: Option<&[String]>,
) -> Result<(), StorageError> {
    let Some(references) = references else {
        // "This sender does not know." Not an empty list, and not a reason to
        // forget what another sender told us.
        return Ok(());
    };

    // Drop this note from every row, then add it back where it belongs, so a
    // reference the note no longer carries stops pointing at it.
    let existing: Vec<CachedAttachment> = conn
        .prepare(&format!("SELECT {COLUMNS} FROM attachments"))
        .map_err(failed)?
        .query_map([], read_row)
        .map_err(failed)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(failed)?;

    for row in existing {
        let wanted = references.contains(&row.attachment_id);
        let present = row.note_refs.iter().any(|id| id == note_id);
        if wanted == present {
            continue;
        }
        let mut refs = row.note_refs.clone();
        if wanted {
            refs.push(note_id.to_owned());
        } else {
            refs.retain(|id| id != note_id);
        }
        refs.sort();
        refs.dedup();
        write_refs(conn, &row.attachment_id, &refs)?;
    }

    // A reference to an attachment this device has never fetched still gets a
    // row, so the note can show a placeholder and a later fetch has somewhere
    // to land. An id with no manifest is "known about, not yet pulled".
    for attachment_id in references {
        if get(conn, attachment_id)?.is_none() {
            conn.execute(
                "INSERT INTO attachments (attachment_id, note_refs) VALUES (?1, ?2)",
                rusqlite::params![
                    attachment_id,
                    serde_json::to_string(&[note_id]).unwrap_or_else(|_| "[]".to_owned())
                ],
            )
            .map_err(failed)?;
        }
    }
    Ok(())
}

fn write_refs(conn: &Connection, attachment_id: &str, refs: &[String]) -> Result<(), StorageError> {
    conn.execute(
        "UPDATE attachments SET note_refs = ?2 WHERE attachment_id = ?1",
        rusqlite::params![
            attachment_id,
            serde_json::to_string(refs).unwrap_or_else(|_| "[]".to_owned())
        ],
    )
    .map_err(failed)?;
    Ok(())
}

/// Every attachment one note references.
///
/// **An empty list is not "this note has no attachments"** unless a sender
/// said so: it is also what a note whose references have never arrived looks
/// like. The caller that needs the difference reads the note payload's own
/// field, which is the only place the distinction lives (§14.7).
pub fn for_note(conn: &Connection, note_id: &str) -> Result<Vec<CachedAttachment>, StorageError> {
    let rows = conn
        .prepare(&format!("SELECT {COLUMNS} FROM attachments"))
        .map_err(failed)?
        .query_map([], read_row)
        .map_err(failed)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(failed)?;

    Ok(rows
        .into_iter()
        .filter(|row| row.note_refs.iter().any(|id| id == note_id))
        .collect())
}

// MARK: - N203, the bounded cache

/// What one eviction pass decided.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Eviction {
    /// Paths the caller must unlink, relative to `images/`.
    pub paths: Vec<String>,
    /// Ciphertext bytes the pass reclaimed.
    pub reclaimed: i64,
}

/// Evicts least-recently-downloaded bytes until the cache fits `budget_bytes`.
///
/// Oldest `downloaded_at` first, which is the cheapest defensible order: it
/// needs no access tracking, and a picture nobody has opened since it arrived
/// is the one a user misses least.
///
/// **Never removes a row and never touches a pinned one.** A pinned row that
/// alone exceeds the budget is left alone and the pass returns under-budget
/// rather than breaking the promise; a cache cannot both honour a pin and
/// guarantee a ceiling, and the pin is the explicit instruction.
pub fn evict_to_budget(conn: &Connection, budget_bytes: i64) -> Result<Eviction, StorageError> {
    let mut rows = conn
        .prepare(&format!(
            "SELECT {COLUMNS} FROM attachments \
             WHERE local_path IS NOT NULL \
             ORDER BY downloaded_at IS NULL DESC, downloaded_at ASC"
        ))
        .map_err(failed)?
        .query_map([], read_row)
        .map_err(failed)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(failed)?;

    let mut total: i64 = rows.iter().map(|row| row.remote_size.unwrap_or(0)).sum();
    let mut eviction = Eviction {
        paths: Vec::new(),
        reclaimed: 0,
    };

    for row in rows.drain(..) {
        if total <= budget_bytes {
            break;
        }
        if row.pinned {
            continue;
        }
        let Some(path) = row.local_path.clone() else {
            continue;
        };
        let size = row.remote_size.unwrap_or(0);
        conn.execute(
            "UPDATE attachments SET local_path = NULL, downloaded_at = NULL \
             WHERE attachment_id = ?1",
            rusqlite::params![row.attachment_id],
        )
        .map_err(failed)?;
        total -= size;
        eviction.reclaimed += size;
        eviction.paths.push(path);
    }

    Ok(eviction)
}

/// The ciphertext bytes this cache currently holds on disk.
pub fn cached_bytes(conn: &Connection) -> Result<i64, StorageError> {
    conn.query_row(
        "SELECT COALESCE(SUM(remote_size), 0) FROM attachments WHERE local_path IS NOT NULL",
        [],
        |row| row.get(0),
    )
    .map_err(failed)
}

/// Every path the cache believes is on disk.
///
/// For the sweep that reclaims bytes orphaned when a shell died between
/// [`evict_to_budget`] clearing a column and unlinking the file: anything in
/// `images/` that is not in this list is unreferenced.
pub fn orphan_candidates(conn: &Connection) -> Result<Vec<String>, StorageError> {
    let paths = conn
        .prepare("SELECT local_path FROM attachments WHERE local_path IS NOT NULL")
        .map_err(failed)?
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(failed)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(failed)?;
    Ok(paths)
}
