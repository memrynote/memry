//! A note or journal body as the indexer reads it: the durable log replayed
//! into a document, and its `extract_text` output cached in `note_bodies`
//! (§A.3).
//!
//! The cache is keyed by [`body_version`], which moves whenever the log can
//! read differently. #4315: it used to be the sum of the two namespaces'
//! high-water sequences, and a server snapshot does not raise those. Desktop
//! pushes a new day's first update with no text and the text as a snapshot
//! covering the same sequence, so a reindex between the two cached an empty
//! body that no later pass replaced, and the day never matched a search.

use std::sync::Arc;

use rusqlite::{Connection, OptionalExtension as _, params};
use sha2::{Digest as _, Sha256};

use crate::api::errors::StorageError;
use crate::crdt::errors::CrdtError;
use crate::crdt::registry::{Document, DocumentRegistry, UpdateSink};
use crate::crdt::text_extract::extract_text;
use crate::crdt::update_log::{self, LOCAL_NAMESPACE_PREFIX};

use super::failed;

/// The device id the read-only body materialisation opens documents under.
///
/// It never writes an update, so its Yjs client id never reaches the log.
const READER_DEVICE_ID: &str = "memry-core-indexer";

/// The body's `extract_text` output, from `note_bodies` when its
/// `source_seq` still matches [`body_version`], otherwise replayed and stored.
pub(super) fn body_text(
    data: &Connection,
    doc_id: &str,
    now_ms: i64,
) -> Result<String, StorageError> {
    let version = body_version(data, doc_id)?;
    let stored = data
        .query_row(
            "SELECT text, source_seq FROM note_bodies WHERE note_id = ?1",
            params![doc_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<i64>>(1)?)),
        )
        .optional()
        .map_err(failed)?;
    if let Some((text, Some(source_seq))) = stored
        && source_seq == version
    {
        return Ok(text);
    }

    let text = match body_document(data, doc_id)? {
        Some(document) => extract_text(&document).map_err(|error| crdt_failed(doc_id, error))?,
        None => String::new(),
    };
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
            version,
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
pub(super) fn body_document(
    data: &Connection,
    doc_id: &str,
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

/// What the log looks like for `doc_id`, as a non-negative integer: per
/// namespace, the update log's high-water sequence and row count, and the
/// snapshot's sequence, stamp and size. An appended update (a gap filled
/// below the high water included), a replaced snapshot and a compaction each
/// change it. The one freshness token for a `note_bodies` row: the journal
/// reads compare against it too.
pub(crate) fn body_version(data: &Connection, doc_id: &str) -> Result<i64, StorageError> {
    let local = format!("{LOCAL_NAMESPACE_PREFIX}{doc_id}");
    let mut parts = Vec::with_capacity(2);
    for row_id in [doc_id, local.as_str()] {
        let part: String = data
            .query_row(
                "SELECT (SELECT COALESCE(MAX(seq), 0) || ':' || COUNT(*)
                         FROM yjs_updates WHERE doc_id = ?1)
                     || ':' || COALESCE((SELECT last_seq || ':' || compacted_at || ':'
                                                || length(snapshot)
                                         FROM yjs_snapshots WHERE doc_id = ?1), '-')",
                params![row_id],
                |row| row.get(0),
            )
            .map_err(failed)?;
        parts.push(part);
    }
    let digest = Sha256::digest(parts.join("|").as_bytes());
    let mut first = [0u8; 8];
    first.copy_from_slice(&digest[..8]);
    Ok(i64::from_be_bytes(first) & i64::MAX)
}

pub(super) fn crdt_failed(doc_id: &str, error: CrdtError) -> StorageError {
    StorageError::Failed {
        what: format!("body of {doc_id} could not be read for indexing: {error}"),
    }
}
