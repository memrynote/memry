//! Stage 36c4: the Yjs documents Step 37 folded from the Electron store, the body pushes Electron
//! still owed the server, its body sync state and body debts, and the hash of each document's
//! file.
//!
//! Electron's store wins over the file: `seedFromMarkdown` returns on a non-empty fragment
//! (`crdt-provider.ts:1853-1855`), and the debounced write-back (`crdt-writeback.ts`) writes the
//! body over a file whose hash is the cached one, keeping the file as a version
//! (`keepVersionBeforeWriteback`). A body ahead of its file at rest (a crash before the write-back,
//! a failed write-back) reaches the file at the next write-back. The import keeps that: a body
//! the file does not hold gets a row stamped before its log entry, and the first session's
//! write-back writes it ([`ImportWriter::put_file_hashes`]). The Electron files and the vault
//! files are never written here.

use std::collections::HashSet;
use std::io::Read;
use std::path::Path;
use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use memry_core::crdt::{BODY_FRAGMENT, DocumentRegistry};
use memry_core::domain::external_feed::same_text;
use memry_core::markdown::convert::api::Converter;
use memry_core::markdown::convert::restore::SerializeOptions;
use memry_core::markdown::frontmatter::split_frontmatter_block;
use memry_core::markdown::schema::callout_types::CalloutTypes;
use memry_core::storage::import::{
    ImportBodyPush, ImportBodySync, ImportDocument, ImportFileHash, ImportWriter,
};
use rusqlite::{Connection, OptionalExtension};

use super::source::source_error;
use super::tables::note_file::MAX_FILE_BYTES;
use super::tables::queue::NOTE_BODY_TYPE;
use super::tables::records::malformed;
use super::tables::{SourceDb, TableStats};
use super::{FoldedDoc, ImportError, TableCtx, VaultImportInput, read_source_id};
use crate::vault::hash::content_hash;
use crate::vault::paths::open_vault_file;

/// `NOTE_BODY_FULL_STATE_PAYLOAD` (`sync-client/queue.ts`): the document's whole state is owed.
const FULL_STATE_PAYLOAD: &str = "";

/// The longest `note_body` payload read, in base64 characters. A body update past it is far
/// beyond what the server takes in one push, so the row is refused rather than decoded.
pub const MAX_BODY_PAYLOAD: usize = 64 << 20;

/// The `sync_queue` `note_body` rows, oldest first, as the body pushes they owe: the decoded
/// update, or for an empty payload the document's whole state. Never collapsed. A row whose
/// document Step 37 did not hand over fails the import with
/// [`ImportError::OrphanBodyQueueRow`].
pub fn queued_body_pushes(
    source: &Connection,
    docs: &[FoldedDoc],
) -> Result<Vec<ImportBodyPush>, ImportError> {
    let err = |e| source_error(SourceDb::Data, e);
    let mut stmt = source
        .prepare(
            "SELECT rowid, item_id, payload, created_at FROM sync_queue WHERE type = ?1
              ORDER BY created_at ASC, rowid ASC",
        )
        .map_err(err)?;
    let mut rows = stmt.query([NOTE_BODY_TYPE]).map_err(err)?;
    let mut pushes = Vec::new();
    let mut orphans = Vec::new();
    while let Some(row) = rows.next().map_err(err)? {
        let rowid: i64 = row.get("rowid").map_err(err)?;
        let doc_id = read_source_id(row, SourceDb::Data, "sync_queue", "item_id")?;
        let payload: Option<String> = row
            .get("payload")
            .map_err(|_| malformed("sync_queue", rowid, "a note_body payload is not text"))?;
        let created_at: i64 = row
            .get("created_at")
            .map_err(|_| malformed("sync_queue", rowid, "created_at is not an integer"))?;
        let Some(doc) = docs.iter().find(|doc| doc.doc_id == doc_id) else {
            orphans.push(doc_id);
            continue;
        };
        let update = decode_payload(payload.as_deref().unwrap_or(FULL_STATE_PAYLOAD), rowid)?
            .unwrap_or_else(|| doc.state.clone());
        pushes.push(ImportBodyPush {
            doc_id,
            update,
            enqueued_at: created_at,
        });
    }
    if !orphans.is_empty() {
        orphans.sort();
        orphans.dedup();
        return Err(ImportError::OrphanBodyQueueRow { doc_ids: orphans });
    }
    Ok(pushes)
}

/// A `note_body` payload's update bytes, or `None` for the full-state payload. The length is
/// checked before anything is decoded.
pub fn decode_payload(payload: &str, rowid: i64) -> Result<Option<Vec<u8>>, ImportError> {
    if payload == FULL_STATE_PAYLOAD {
        return Ok(None);
    }
    if payload.len() > MAX_BODY_PAYLOAD {
        return Err(malformed(
            "sync_queue",
            rowid,
            "a note_body payload is over the size cap",
        ));
    }
    STANDARD
        .decode(payload)
        .map(Some)
        .map_err(|_| malformed("sync_queue", rowid, "a note_body payload is not base64"))
}

/// The `note_body_sync` rows, and one full-state push for each document whose last body push
/// was sent and never confirmed (`last_sent_at` past `last_confirmed_at`): the push in flight
/// when Electron quit may never have reached the server, and a push the server already holds
/// changes nothing.
fn body_sync(
    source: &Connection,
    docs: &[FoldedDoc],
) -> Result<(Vec<ImportBodySync>, Vec<ImportBodyPush>, u64), ImportError> {
    let err = |e| source_error(SourceDb::Data, e);
    let mut stmt = source
        .prepare(
            "SELECT rowid, note_id, last_sent_at, last_confirmed_at, last_failed_at,
                    last_rejected_at, last_snapshot_at, pushed_state_vector, updated_at
               FROM note_body_sync ORDER BY note_id",
        )
        .map_err(err)?;
    let mut rows = stmt.query([]).map_err(err)?;
    let (mut synced, mut pushes, mut vectors) = (Vec::new(), Vec::new(), 0u64);
    while let Some(row) = rows.next().map_err(err)? {
        let rowid: i64 = row.get("rowid").map_err(err)?;
        let instant = |name: &str| {
            row.get::<_, Option<i64>>(name)
                .map_err(|_| malformed("note_body_sync", rowid, "an instant is not an integer"))
        };
        let item = ImportBodySync {
            note_id: read_source_id(row, SourceDb::Data, "note_body_sync", "note_id")?,
            last_sent_at: instant("last_sent_at")?,
            last_confirmed_at: instant("last_confirmed_at")?,
            last_failed_at: instant("last_failed_at")?,
            last_rejected_at: instant("last_rejected_at")?,
            last_snapshot_at: instant("last_snapshot_at")?,
            updated_at: instant("updated_at")?
                .ok_or_else(|| malformed("note_body_sync", rowid, "updated_at is missing"))?,
        };
        if row
            .get::<_, Option<String>>("pushed_state_vector")
            .map_err(err)?
            .is_some()
        {
            vectors += 1;
        }
        let in_flight = match (item.last_sent_at, item.last_confirmed_at) {
            (Some(sent), Some(confirmed)) => sent > confirmed,
            (Some(_), None) => true,
            (None, _) => false,
        };
        if in_flight && let Some(doc) = docs.iter().find(|doc| doc.doc_id == item.note_id) {
            pushes.push(ImportBodyPush {
                doc_id: doc.doc_id.clone(),
                update: doc.state.clone(),
                enqueued_at: item.last_sent_at.unwrap_or(item.updated_at),
            });
        }
        synced.push(item);
    }
    Ok((synced, pushes, vectors))
}

/// The `note_body_sync` importer: the rows as stored, `pushed_state_vector` dropped (the core
/// keeps none), plus the full-state pushes of [`body_sync`].
pub fn note_body_sync(ctx: &mut TableCtx<'_>) -> Result<TableStats, ImportError> {
    let (rows, pushes, vectors) = body_sync(ctx.source, ctx.docs)?;
    ctx.writer.put_note_body_sync(&rows)?;
    let queued = ctx.writer.put_body_pushes(&pushes)?;
    let mut stats = TableStats {
        written: rows.len() as u64,
        ..TableStats::default()
    };
    if vectors > 0 {
        stats.notices.push(("pushedStateVectors", vectors));
    }
    let in_flight = queued.iter().filter(|queued| **queued).count() as u64;
    if in_flight > 0 {
        stats.notices.push(("inFlightBodyPushes", in_flight));
    }
    Ok(stats)
}

/// Every body push the import queues, in the order it queues them: Electron's queued rows, then
/// the in-flight full states. Check 4 holds the staged outbox to it.
pub fn planned_body_pushes(
    source: &Connection,
    docs: &[FoldedDoc],
) -> Result<Vec<ImportBodyPush>, ImportError> {
    let mut pushes = queued_body_pushes(source, docs)?;
    pushes.extend(body_sync(source, docs)?.1);
    Ok(pushes)
}

/// `crdt_body_debts` and `crdt_body_withheld`: each note owes a body pull ([`body_debt::owe`]).
/// The failure count starts again at 0.
///
/// [`body_debt::owe`]: memry_core::sync::body_debt::owe
pub fn body_debts(ctx: &mut TableCtx<'_>, table: &'static str) -> Result<TableStats, ImportError> {
    let ids = note_ids(ctx.source, table)?;
    ctx.writer.put_body_debts(&ids)?;
    Ok(TableStats {
        written: ids.len() as u64,
        ..TableStats::default()
    })
}

pub fn crdt_body_debts(ctx: &mut TableCtx<'_>) -> Result<TableStats, ImportError> {
    body_debts(ctx, "crdt_body_debts")
}

pub fn crdt_body_withheld(ctx: &mut TableCtx<'_>) -> Result<TableStats, ImportError> {
    body_debts(ctx, "crdt_body_withheld")
}

/// `crdt_owed_file_bodies`: each note's file is ahead of its document, recorded at the time
/// Electron recorded it (`crdt-owed-file-body.ts:41`, epoch milliseconds).
pub fn crdt_owed_file_bodies(ctx: &mut TableCtx<'_>) -> Result<TableStats, ImportError> {
    let rows = owed_file_bodies(ctx.source)?;
    ctx.writer.put_owed_file_bodies(&rows)?;
    Ok(TableStats {
        written: rows.len() as u64,
        ..TableStats::default()
    })
}

fn owed_file_bodies(source: &Connection) -> Result<Vec<(String, i64)>, ImportError> {
    let err = |e| source_error(SourceDb::Data, e);
    let mut stmt = source
        .prepare("SELECT rowid, note_id, created_at FROM crdt_owed_file_bodies ORDER BY note_id")
        .map_err(err)?;
    let mut rows = stmt.query([]).map_err(err)?;
    let mut owed = Vec::new();
    while let Some(row) = rows.next().map_err(err)? {
        let rowid: i64 = row.get("rowid").map_err(err)?;
        let created_at: i64 = row.get("created_at").map_err(|_| {
            malformed(
                "crdt_owed_file_bodies",
                rowid,
                "created_at is not an integer",
            )
        })?;
        owed.push((
            read_source_id(row, SourceDb::Data, "crdt_owed_file_bodies", "note_id")?,
            created_at,
        ));
    }
    Ok(owed)
}

fn note_ids(source: &Connection, table: &'static str) -> Result<Vec<String>, ImportError> {
    let err = |e| source_error(SourceDb::Data, e);
    let mut stmt = source
        .prepare(&format!("SELECT note_id FROM {table} ORDER BY note_id"))
        .map_err(err)?;
    let mut rows = stmt.query([]).map_err(err)?;
    let mut ids = Vec::new();
    while let Some(row) = rows.next().map_err(err)? {
        ids.push(read_source_id(row, SourceDb::Data, table, "note_id")?);
    }
    Ok(ids)
}

/// Writes the documents, their cursors, the extra owed documents' debts and the hash of each
/// document's file. Runs after every table, so the `note_files` rows and the owed markers it
/// reads are staged.
pub(super) fn import_documents(
    input: &VaultImportInput<'_>,
    source: &Connection,
    index: &Connection,
    writer: &mut ImportWriter,
) -> Result<(), ImportError> {
    let docs: Vec<ImportDocument> = input
        .docs
        .iter()
        .map(|doc| ImportDocument {
            doc_id: doc.doc_id.clone(),
            state: doc.state.clone(),
            watermark: doc.watermark,
        })
        .collect();
    writer.put_documents(&docs, input.now_ms)?;
    writer.put_body_debts(&input.extra_owed_docs)?;
    let owed: HashSet<String> = owed_file_bodies(source)?
        .into_iter()
        .map(|(id, _)| id)
        .collect();
    let mut hashes = Vec::new();
    for doc in &input.docs {
        if owed.contains(&doc.doc_id) {
            continue;
        }
        if let Some(hash) = file_hash(input.vault_dir.as_path(), index, writer, doc)? {
            hashes.push(hash);
        }
    }
    writer.put_file_hashes(&hashes, input.now_ms)?;
    Ok(())
}

/// The hashes of `doc`'s markdown file, when Electron read it (`note_cache.content_hash`; a
/// file it never read is never written over, `crdt-writeback.ts:827-832`). The body is `ahead`
/// unless its text is the file's now, as the feed reads them (`same_text`).
fn file_hash(
    vault: &Path,
    index: &Connection,
    writer: &ImportWriter,
    doc: &FoldedDoc,
) -> Result<Option<ImportFileHash>, ImportError> {
    let Some(row) = writer.note_file(&doc.doc_id)? else {
        return Ok(None);
    };
    if row.file_type != "markdown" {
        return Ok(None);
    }
    let cached: Option<String> = index
        .query_row(
            "SELECT content_hash FROM note_cache WHERE id = ?1",
            [&doc.doc_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| source_error(SourceDb::Index, e))?
        .flatten();
    let Some(cached) = cached else {
        return Ok(None);
    };
    let Some(text) = read_file(vault, &row.path) else {
        return Ok(Some(ImportFileHash {
            note_id: doc.doc_id.clone(),
            content_hash: cached,
            file_hash: None,
            ahead: true,
        }));
    };
    let on_disk = content_hash(&text);
    if body_is_file(doc, &row.path, &text) {
        return Ok(Some(ImportFileHash {
            note_id: doc.doc_id.clone(),
            content_hash: on_disk.clone(),
            file_hash: Some(on_disk),
            ahead: false,
        }));
    }
    Ok(Some(ImportFileHash {
        note_id: doc.doc_id.clone(),
        content_hash: cached,
        file_hash: Some(on_disk),
        ahead: true,
    }))
}

/// The file's text, read as Node reads it (UTF-8 with replacement); `None` for a file that is
/// missing, refused or past [`MAX_FILE_BYTES`].
fn read_file(vault: &Path, rel: &str) -> Option<String> {
    let file = open_vault_file(vault, rel).ok()??;
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return None;
    }
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// Whether the folded body serializes to the text of the file's body, by the default converter.
/// A body this cannot tell (one it cannot serialize, a custom callout the settings would name)
/// counts as ahead: the write-back compares again with the vault's converter and writes nothing
/// when the file is the body's.
fn body_is_file(doc: &FoldedDoc, path: &str, text: &str) -> bool {
    let document = match DocumentRegistry::new("import", Arc::new(|_: &str, _: &[u8]| {}))
        .get_or_open(&doc.doc_id)
        .and_then(|document| document.apply_durable_update(&doc.state).map(|()| document))
    {
        Ok(document) => document,
        Err(_) => return false,
    };
    let options = SerializeOptions {
        note_path: Some(path),
        ..SerializeOptions::default()
    };
    let converter = Converter::new(CalloutTypes::new(Vec::new()));
    let Some(body) = converter.serialize_note_body(&document, BODY_FRAGMENT, &options) else {
        return false;
    };
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    same_text(&body.markdown, split_frontmatter_block(text).body)
}
