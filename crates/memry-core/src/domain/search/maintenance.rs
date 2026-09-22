//! Keeping `index.db` in step with `data.db` (T131, FR-053, data-model §A.5).
//!
//! The query half is [`super`]; this half is everything that writes a row of
//! `fts_notes` or `fts_tasks`, and the watermarks in `index_meta` that let it
//! do so without re-reading the whole vault.
//!
//! ## Incremental maintenance
//!
//! §A.5 gives `index_meta` a per-table watermark "so an incremental reindex is
//! possible and a full rebuild is only needed when the watermark is missing".
//! The watermark is an epoch-millisecond stamp and the columns compared against
//! it are all written by **this device's** clock at apply time — the projection
//! rows' `synced_at`, the update log's `created_at` and `compacted_at`.
//! `sync_items.updated_at` is *not* used: it carries the server's instant for a
//! pulled record, so it is not monotone in local time and a pull of an older
//! record would land below the watermark and never be indexed.
//!
//! The comparison is `>=`, not `>`, and the stored watermark is the largest
//! stamp the pass saw. A row written in the same millisecond the pass read is
//! therefore re-indexed next time rather than missed; re-indexing is a delete
//! and an insert of the same bytes, so the safe direction costs nothing.
//!
//! A missing watermark, or an `index_meta` `data.user_version` that does not
//! match `data.db`, forces a full rebuild: both FTS tables are emptied and
//! every live row is re-indexed.

use std::collections::BTreeSet;
use std::sync::Arc;

use rusqlite::{Connection, OptionalExtension as _, params};
use sha2::{Digest as _, Sha256};

use crate::api::errors::StorageError;
use crate::crdt::blocks::extract_blocks;
use crate::crdt::errors::CrdtError;
use crate::crdt::registry::Document;
use crate::crdt::registry::{DocumentRegistry, UpdateSink};
use crate::crdt::text_extract::extract_text;
use crate::crdt::update_log::{self, LOCAL_NAMESPACE_PREFIX};
use crate::storage::repositories::StoredPayload;
use crate::storage::repositories::projectors::{self, strings, text};

use super::failed;

/// `index_meta` key: the `data.db` `user_version` the index was built against.
pub const DATA_VERSION_KEY: &str = "data.user_version";
/// `index_meta` key: the `fts_notes` watermark.
pub const NOTES_WATERMARK_KEY: &str = "watermark.fts_notes";
/// `index_meta` key: the `fts_tasks` watermark.
pub const TASKS_WATERMARK_KEY: &str = "watermark.fts_tasks";

/// The device id the read-only body materialisation opens documents under.
///
/// It never writes an update, so its Yjs client id never reaches the log.
const READER_DEVICE_ID: &str = "memry-core-indexer";

/// What one [`reindex`] pass did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Reindexed {
    /// Both tables were emptied first: the watermark was missing or `data.db`
    /// moved to a schema version this index was not built against.
    pub full: bool,
    pub notes_indexed: usize,
    pub notes_removed: usize,
    pub tasks_indexed: usize,
    pub tasks_removed: usize,
    /// Rows the apply path had already flagged corrupt. Not an error here.
    pub corrupt_skipped: usize,
}

/// Brings `index.db` up to date with `data.db`, incrementally where it can.
///
/// Safe to call at any time and on any schedule: it is idempotent, and calling
/// it against an empty `index.db` is the supported full rebuild.
pub fn reindex(
    data: &Connection,
    index: &Connection,
    now_ms: i64,
) -> Result<Reindexed, StorageError> {
    let version: i64 = data
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(failed)?;

    let transaction = index.unchecked_transaction().map_err(failed)?;
    let indexed = meta_number(&transaction, DATA_VERSION_KEY)?;
    let notes_from = meta_number(&transaction, NOTES_WATERMARK_KEY)?;
    let tasks_from = meta_number(&transaction, TASKS_WATERMARK_KEY)?;

    let full = indexed != Some(version) || notes_from.is_none() || tasks_from.is_none();
    if full {
        transaction
            .execute_batch("DELETE FROM fts_notes; DELETE FROM fts_tasks;")
            .map_err(failed)?;
    }
    let notes_from = if full { 0 } else { notes_from.unwrap_or(0) };
    let tasks_from = if full { 0 } else { tasks_from.unwrap_or(0) };

    let mut done = Reindexed {
        full,
        ..Reindexed::default()
    };
    let (note_ids, notes_high) = note_candidates(data, notes_from)?;
    for id in &note_ids {
        index_note(data, &transaction, id, now_ms, &mut done)?;
    }
    let (task_ids, tasks_high) = task_candidates(data, tasks_from)?;
    for id in &task_ids {
        index_task(data, &transaction, id, &mut done)?;
    }

    meta_set(&transaction, DATA_VERSION_KEY, &version.to_string())?;
    meta_set(
        &transaction,
        NOTES_WATERMARK_KEY,
        &notes_high.unwrap_or(notes_from).max(notes_from).to_string(),
    )?;
    meta_set(
        &transaction,
        TASKS_WATERMARK_KEY,
        &tasks_high.unwrap_or(tasks_from).max(tasks_from).to_string(),
    )?;
    transaction.commit().map_err(failed)?;
    Ok(done)
}

/// Every note or journal whose record, body log or body snapshot moved at or
/// after `from`, and the largest stamp seen.
fn note_candidates(
    data: &Connection,
    from: i64,
) -> Result<(BTreeSet<String>, Option<i64>), StorageError> {
    // A `synced_at` this device never wrote is read as "changed" rather than
    // as "older than the watermark": a NULL compares false against every
    // bound, so the null-tolerant reading is the only one that cannot lose a
    // row. It costs a re-index per pass and never a missing note.
    let sql = "
        SELECT id AS doc_id, synced_at AS stamp FROM notes
          WHERE synced_at IS NULL OR synced_at >= ?1
        UNION ALL
        SELECT id, synced_at FROM journal_entries
          WHERE synced_at IS NULL OR synced_at >= ?1
        UNION ALL
        SELECT CASE WHEN doc_id LIKE ?2 THEN substr(doc_id, ?3) ELSE doc_id END, created_at
          FROM yjs_updates WHERE created_at >= ?1
        UNION ALL
        SELECT CASE WHEN doc_id LIKE ?2 THEN substr(doc_id, ?3) ELSE doc_id END, compacted_at
          FROM yjs_snapshots WHERE compacted_at >= ?1";
    let local = format!("{LOCAL_NAMESPACE_PREFIX}%");
    let skip = LOCAL_NAMESPACE_PREFIX.len() as i64 + 1;
    candidates(data, sql, params![from, local, skip])
}

/// Every task whose projection row moved at or after `from`.
fn task_candidates(
    data: &Connection,
    from: i64,
) -> Result<(BTreeSet<String>, Option<i64>), StorageError> {
    candidates(
        data,
        "SELECT id AS doc_id, synced_at AS stamp FROM tasks
           WHERE synced_at IS NULL OR synced_at >= ?1",
        params![from],
    )
}

fn candidates(
    data: &Connection,
    sql: &str,
    bound: &[&dyn rusqlite::ToSql],
) -> Result<(BTreeSet<String>, Option<i64>), StorageError> {
    let mut statement = data.prepare(sql).map_err(failed)?;
    let rows = statement
        .query_map(bound, |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<i64>>(1)?))
        })
        .map_err(failed)?;
    let mut ids = BTreeSet::new();
    let mut high: Option<i64> = None;
    for row in rows {
        let (id, stamp) = row.map_err(failed)?;
        ids.insert(id);
        high = high.max(stamp);
    }
    Ok((ids, high))
}

/// Re-indexes one note or journal: delete first, then insert if it still earns
/// a row.
fn index_note(
    data: &Connection,
    index: &Connection,
    id: &str,
    now_ms: i64,
    done: &mut Reindexed,
) -> Result<(), StorageError> {
    index
        .execute("DELETE FROM fts_notes WHERE id = ?1", params![id])
        .map_err(failed)?;
    // The note's outgoing links go with it. Deleting first means a note that
    // stopped linking somewhere really stops: an insert-only pass would leave
    // a backlink the source no longer makes.
    index
        .execute("DELETE FROM note_links WHERE source_id = ?1", params![id])
        .map_err(failed)?;

    // The primary key is (item_type, item_id), so one id could in principle
    // name both a note and a journal. `journal` sorts first and one row is
    // indexed; the ambiguity is not this module's to resolve.
    let row = data
        .query_row(
            "SELECT item_type, payload, deleted_at, corrupt_reason FROM sync_items
             WHERE item_id = ?1 AND item_type IN ('note', 'journal')
             ORDER BY item_type LIMIT 1",
            params![id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            },
        )
        .optional()
        .map_err(failed)?;

    let Some((item_type, payload, deleted_at, corrupt)) = row else {
        done.notes_removed += 1;
        return Ok(());
    };
    if deleted_at.is_some() {
        done.notes_removed += 1;
        return Ok(());
    }
    if corrupt.is_some() {
        done.corrupt_skipped += 1;
        return Ok(());
    }
    let Some(payload) = payload else {
        // `metadata-only`: the body of the record has not been pulled yet. The
        // fill bumps `synced_at`, so it comes back as a candidate.
        return Ok(());
    };

    let view = read_payload(&item_type, id, &payload)?;
    // A journal's title is not projected anywhere, so it is read from the
    // payload like every other field here, and falls back to its calendar date.
    let title = text(&view, "title")
        .filter(|title| !title.is_empty())
        .or_else(|| text(&view, "date"))
        .unwrap_or_default();
    index
        .execute(
            "INSERT INTO fts_notes (id, title, content, tags) VALUES (?1, ?2, ?3, ?4)",
            params![
                id,
                title,
                body_text(data, id, now_ms)?,
                strings(&view, "tags").join(" "),
            ],
        )
        .map_err(failed)?;
    index_links(data, index, id, now_ms)?;
    done.notes_indexed += 1;
    Ok(())
}

/// Projects one note's outgoing wiki links into `note_links` (N800).
///
/// **The table existed and nothing wrote a row into it**, which is why
/// backlinks could not be answered: a query over it would have returned
/// nothing, forever, and looked like a note with no backlinks.
///
/// `target_id` is resolved here rather than at query time, and left `NULL`
/// when no note carries that title — which is how a forward reference to a
/// note that does not exist yet survives until it is created. The title is
/// always stored, so the link is still a link in the meantime.
fn index_links(
    data: &Connection,
    index: &Connection,
    id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    let document = body_document(data, id, now_ms)?;
    let Some(document) = document else {
        return Ok(());
    };
    let blocks = extract_blocks(&document).map_err(|error| crdt_failed(id, error))?;

    // One row per distinct title: the primary key is (source_id, target_title)
    // and a note linking to the same place twice is still one link between two
    // notes. The mention count belongs to the reader, not to the edge.
    let mut seen: BTreeSet<String> = BTreeSet::new();
    for block in &blocks {
        for run in &block.inline {
            let is_link = run
                .marks
                .iter()
                .any(|mark| mark == "wikiLink" || mark == "linkMention");
            let Some(target) = run.target.as_deref().filter(|_| is_link) else {
                continue;
            };
            let target = target.trim();
            if target.is_empty() {
                continue;
            }
            seen.insert(target.to_owned());
        }
    }

    for title in seen {
        // Resolved by title against the live notes, which is what a wiki link
        // names (§12.3).
        let target_id: Option<String> = data
            .query_row(
                "SELECT id FROM notes WHERE title = ?1 AND deleted_at IS NULL LIMIT 1",
                params![&title],
                |row| row.get(0),
            )
            .optional()
            .map_err(failed)?;
        index
            .execute(
                "INSERT INTO note_links (source_id, target_id, target_title)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(source_id, target_title) DO UPDATE SET
                     target_id = excluded.target_id",
                params![id, target_id, title],
            )
            .map_err(failed)?;
    }
    Ok(())
}

/// Re-indexes one task. A task has no body document, so `description` is the
/// whole of its second column.
fn index_task(
    data: &Connection,
    index: &Connection,
    id: &str,
    done: &mut Reindexed,
) -> Result<(), StorageError> {
    index
        .execute("DELETE FROM fts_tasks WHERE id = ?1", params![id])
        .map_err(failed)?;

    let row = data
        .query_row(
            "SELECT payload, deleted_at, corrupt_reason FROM sync_items
             WHERE item_type = 'task' AND item_id = ?1",
            params![id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .optional()
        .map_err(failed)?;

    let Some((payload, deleted_at, corrupt)) = row else {
        done.tasks_removed += 1;
        return Ok(());
    };
    if deleted_at.is_some() {
        done.tasks_removed += 1;
        return Ok(());
    }
    if corrupt.is_some() {
        done.corrupt_skipped += 1;
        return Ok(());
    }
    let Some(payload) = payload else {
        return Ok(());
    };

    let view = read_payload("task", id, &payload)?;
    index
        .execute(
            "INSERT INTO fts_tasks (id, title, description, tags) VALUES (?1, ?2, ?3, ?4)",
            params![
                id,
                text(&view, "title").unwrap_or_default(),
                text(&view, "description").unwrap_or_default(),
                strings(&view, "tags").join(" "),
            ],
        )
        .map_err(failed)?;
    done.tasks_indexed += 1;
    Ok(())
}

/// The stored payload, read through the same reader the projectors use.
///
/// A row the apply path did not flag corrupt but that will not read back is a
/// bug in this build, and it stops the pass instead of quietly leaving a note
/// out of every search result for the life of the install.
fn read_payload(
    item_type: &str,
    item_id: &str,
    payload: &str,
) -> Result<crate::storage::repositories::schema::Object, StorageError> {
    let parsed = StoredPayload::parse(payload).map_err(|error| StorageError::Failed {
        what: format!("{item_type}/{item_id} will not parse for indexing: {error}"),
    })?;
    projectors::read(item_type, parsed.object()).map_err(|error| StorageError::Failed {
        what: format!("{item_type}/{item_id} will not read for indexing: {error}"),
    })
}

/// The body's `extract_text` output, materialised into `note_bodies` on the way
/// past (§A.3).
///
/// `source_seq` is what makes "skip when nothing moved" possible: it holds the
/// **sum** of the two namespaces' high-water sequences. A sum, because the
/// server and local sequence spaces are independent, so a single maximum over
/// both would sit still while the lower of the two advanced; each half is
/// non-decreasing, so the sum is non-decreasing and moves whenever either half
/// does.
fn body_text(data: &Connection, doc_id: &str, now_ms: i64) -> Result<String, StorageError> {
    let high = body_high_water(data, doc_id)?;
    let stored = data
        .query_row(
            "SELECT text, source_seq FROM note_bodies WHERE note_id = ?1",
            params![doc_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<i64>>(1)?)),
        )
        .optional()
        .map_err(failed)?;
    if let Some((text, Some(source_seq))) = &stored
        && *source_seq == high
    {
        return Ok(text.clone());
    }

    let plan = update_log::load_plan(data, doc_id).map_err(|error| crdt_failed(doc_id, error))?;
    let sink: UpdateSink = Arc::new(|_, _| {});
    let document = DocumentRegistry::new(READER_DEVICE_ID, sink)
        .get_or_open(doc_id)
        .map_err(|error| crdt_failed(doc_id, error))?;
    for blob in plan.blobs() {
        document
            .apply_durable_update(blob)
            .map_err(|error| crdt_failed(doc_id, error))?;
    }
    let text = extract_text(&document).map_err(|error| crdt_failed(doc_id, error))?;

    data.execute(
        "INSERT INTO note_bodies (
             note_id, text, seed_markdown, text_sha256, source_seq, materialised_at
         ) VALUES (?1, ?2, NULL, ?3, ?4, ?5)
         ON CONFLICT(note_id) DO UPDATE SET
             text = excluded.text,
             text_sha256 = excluded.text_sha256,
             source_seq = excluded.source_seq,
             materialised_at = excluded.materialised_at",
        params![
            doc_id,
            &text,
            hex::encode(Sha256::digest(text.as_bytes())),
            high,
            now_ms,
        ],
    )
    .map_err(failed)?;
    Ok(text)
}

/// One note's body as a document, rebuilt from the durable log.
///
/// `None` when the log holds nothing for it, which is a note whose body has
/// not arrived rather than an empty one — the two are different and only the
/// first can still change.
fn body_document(
    data: &Connection,
    doc_id: &str,
    _now_ms: i64,
) -> Result<Option<Arc<Document>>, StorageError> {
    let plan = update_log::load_plan(data, doc_id).map_err(|error| crdt_failed(doc_id, error))?;
    let blobs = plan.blobs();
    if blobs.is_empty() {
        return Ok(None);
    }
    let sink: UpdateSink = Arc::new(|_, _| {});
    let document = DocumentRegistry::new(READER_DEVICE_ID, sink)
        .get_or_open(doc_id)
        .map_err(|error| crdt_failed(doc_id, error))?;
    for blob in blobs {
        document
            .apply_durable_update(blob)
            .map_err(|error| crdt_failed(doc_id, error))?;
    }
    Ok(Some(document))
}

fn body_high_water(data: &Connection, doc_id: &str) -> Result<i64, StorageError> {
    let local = format!("{LOCAL_NAMESPACE_PREFIX}{doc_id}");
    let mut high = 0;
    for row_id in [doc_id, local.as_str()] {
        let updates: i64 = data
            .query_row(
                "SELECT COALESCE(MAX(seq), 0) FROM yjs_updates WHERE doc_id = ?1",
                params![row_id],
                |row| row.get(0),
            )
            .map_err(failed)?;
        let folded: i64 = data
            .query_row(
                "SELECT COALESCE((SELECT last_seq FROM yjs_snapshots WHERE doc_id = ?1), 0)",
                params![row_id],
                |row| row.get(0),
            )
            .map_err(failed)?;
        high += updates.max(folded);
    }
    Ok(high)
}

fn meta_number(index: &Connection, key: &str) -> Result<Option<i64>, StorageError> {
    let raw: Option<Option<String>> = index
        .query_row(
            "SELECT value FROM index_meta WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .optional()
        .map_err(failed)?;
    match raw.flatten() {
        None => Ok(None),
        // A watermark that will not parse is not read as "start from zero"
        // silently; it is read as missing, which forces the full rebuild that
        // is the documented recovery for a watermark that cannot be trusted.
        Some(value) => Ok(value.parse::<i64>().ok()),
    }
}

fn meta_set(index: &Connection, key: &str, value: &str) -> Result<(), StorageError> {
    index
        .execute(
            "INSERT INTO index_meta (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )
        .map_err(failed)?;
    Ok(())
}

fn crdt_failed(doc_id: &str, error: CrdtError) -> StorageError {
    StorageError::Failed {
        what: format!("body of {doc_id} could not be read for indexing: {error}"),
    }
}
