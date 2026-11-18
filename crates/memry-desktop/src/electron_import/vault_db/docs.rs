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
//! write-back writes it ([`ImportWriter::put_file_hashes`]). A file edited since Electron read
//! it is fed into the body, as Electron's cached-hash guard does (`crdt-writeback.ts:827-878`),
//! with the body kept as a version first. The Electron files and the vault files are never
//! written here.

use std::collections::{HashMap, HashSet};
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
    ImportBodyPush, ImportBodySync, ImportBodyVersion, ImportDocument, ImportFileHash, ImportWriter,
};
use rusqlite::{Connection, OptionalExtension};

use super::source::source_error;
use super::tables::note_file::MAX_FILE_BYTES;
use super::tables::queue::{NOTE_BODY_TYPE, seconds_ms};
use super::tables::records::malformed;
use super::tables::{SourceDb, TableStats};
use super::{FoldedDoc, ImportError, TableCtx, VaultImportInput, read_source_id};
use crate::vault::hash::content_hash;
use crate::vault::paths::open_vault_file;

/// `NOTE_BODY_FULL_STATE_PAYLOAD` (`sync-client/queue.ts`): the document's whole state is owed.
const FULL_STATE_PAYLOAD: &str = "";

/// The log stamp of a document whose body holds no text the file lacks and that Electron never
/// had confirmed: Electron's rule 3 reads its missing `lastConfirmedAt` as no own body text
/// (`keep-unseen-text.ts:65`, `note-sync-state.ts:207`), and a stamp before every delete does
/// the same in the core's (`sync/delete_keep.rs`).
const NO_OWN_BODY_AT: i64 = 0;

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
        // Electron queues with `mode: 'timestamp'`: epoch seconds.
        let created_at = seconds_ms(row, "created_at", "sync_queue", rowid)?;
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
/// keeps none), plus the full-state pushes of [`body_sync`]. A push whose note or journal day is
/// gone is skipped and counted: Electron's sync row outlives the item it pushed for.
pub fn note_body_sync(ctx: &mut TableCtx<'_>) -> Result<TableStats, ImportError> {
    let (rows, pushes, vectors) = body_sync(ctx.source, ctx.docs)?;
    ctx.writer.put_note_body_sync(&rows)?;
    let mut owned = Vec::with_capacity(pushes.len());
    let mut gone = 0u64;
    for push in pushes {
        match ctx.writer.body_owner(&push.doc_id)? {
            Some(_) => owned.push(push),
            None => gone += 1,
        }
    }
    let queued = ctx.writer.put_body_pushes(&owned)?;
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
    if gone > 0 {
        stats.notices.push(("goneInFlightBodyPushes", gone));
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

/// Writes the documents, their cursors, the extra owed documents' debts, the bodies an outside
/// edit replaces and the hash of each document's file. Runs after every table, so the
/// `note_files` rows and the owed markers it reads are staged.
///
/// A document whose body is ahead of its file is stored at `now_ms`, after its row's stamp, so
/// the first write-back writes it. Any other is stored at Electron's `last_confirmed_at`, the
/// instant its delete-keep rule reads as this device's last own body text
/// (`keep-unseen-text.ts:65`), or at [`NO_OWN_BODY_AT`].
pub(super) fn import_documents(
    input: &VaultImportInput<'_>,
    source: &Connection,
    index: &Connection,
    writer: &mut ImportWriter,
) -> Result<(), ImportError> {
    let owed: HashSet<String> = owed_file_bodies(source)?
        .into_iter()
        .map(|(id, _)| id)
        .collect();
    let confirmed = confirmed_at(source)?;
    let (mut docs, mut hashes, mut versions) = (Vec::new(), Vec::new(), Vec::new());
    for doc in &input.docs {
        let found = match owed.contains(&doc.doc_id) {
            true => None,
            false => file_hash(input.vault_dir.as_path(), source, index, writer, doc)?,
        };
        let ahead = found.as_ref().is_some_and(|(hash, _)| hash.ahead);
        docs.push(ImportDocument {
            doc_id: doc.doc_id.clone(),
            state: doc.state.clone(),
            watermark: doc.watermark,
            created_at: match ahead {
                true => input.now_ms,
                false => confirmed
                    .get(&doc.doc_id)
                    .copied()
                    .unwrap_or(NO_OWN_BODY_AT),
            },
        });
        if let Some((hash, version)) = found {
            hashes.push(hash);
            versions.extend(version);
        }
    }
    writer.put_documents(&docs, input.now_ms)?;
    writer.put_body_debts(&input.extra_owed_docs)?;
    writer.put_body_versions(&versions, input.now_ms)?;
    writer.put_file_hashes(&hashes, input.now_ms)?;
    Ok(())
}

/// `note_body_sync.last_confirmed_at` (epoch ms) by note, where Electron recorded one.
fn confirmed_at(source: &Connection) -> Result<HashMap<String, i64>, ImportError> {
    let err = |e| source_error(SourceDb::Data, e);
    let mut stmt = source
        .prepare(
            "SELECT note_id, last_confirmed_at FROM note_body_sync
              WHERE typeof(last_confirmed_at) = 'integer'",
        )
        .map_err(err)?;
    let mut rows = stmt.query([]).map_err(err)?;
    let mut confirmed = HashMap::new();
    while let Some(row) = rows.next().map_err(err)? {
        let id = read_source_id(row, SourceDb::Data, "note_body_sync", "note_id")?;
        confirmed.insert(id, row.get("last_confirmed_at").map_err(err)?);
    }
    Ok(confirmed)
}

/// The hashes of `doc`'s markdown file, when Electron read it (`note_cache.content_hash`; a
/// file it never read is never written over, `crdt-writeback.ts:827-832`), and the body kept as
/// a version when an outside edit replaces it.
///
/// - The body serializes to the file's text (`same_text`): the row holds the file.
/// - The file is the one Electron read, or is missing, or the body cannot be serialized: the
///   body is `ahead`, and the first write-back writes it, keeping the file as a version.
/// - The file changed since Electron read it: an outside edit made while Electron was closed.
///   The row names the file Electron read and holds the body, so the consumer feeds the edit
///   into the body as Electron's write-back guard would; the body is kept as a version first.
fn file_hash(
    vault: &Path,
    source: &Connection,
    index: &Connection,
    writer: &ImportWriter,
    doc: &FoldedDoc,
) -> Result<Option<(ImportFileHash, Option<ImportBodyVersion>)>, ImportError> {
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
    let row_of = |content_hash: String, file_hash: Option<String>, ahead: bool| ImportFileHash {
        note_id: doc.doc_id.clone(),
        content_hash,
        file_hash,
        ahead,
    };
    let Some(text) = read_file(vault, &row.path) else {
        return Ok(Some((row_of(cached, None, true), None)));
    };
    let on_disk = content_hash(&text);
    let split = split_frontmatter_block(text.strip_prefix('\u{feff}').unwrap_or(&text));
    let body = serialized_body(doc, &row.path);
    if body
        .as_deref()
        .is_some_and(|body| same_text(body, split.body))
    {
        return Ok(Some((row_of(on_disk.clone(), Some(on_disk), false), None)));
    }
    let Some(body) = body.filter(|_| on_disk != cached) else {
        return Ok(Some((row_of(cached, Some(on_disk), true), None)));
    };
    let title: Option<String> = source
        .query_row(
            "SELECT title FROM note_metadata WHERE id = ?1",
            [&doc.doc_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| source_error(SourceDb::Data, e))?;
    let version = ImportBodyVersion {
        note_id: doc.doc_id.clone(),
        content: format!("{}{body}", split.block.unwrap_or("")),
        body,
        title: title.unwrap_or_default(),
    };
    Ok(Some((row_of(cached, Some(on_disk), false), Some(version))))
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

/// The folded body as markdown, by the default converter; `None` for a body it cannot
/// serialize. A custom callout the settings would name may serialize differently here: such a
/// body counts as not the file's, and the write-back compares again with the vault's converter.
fn serialized_body(doc: &FoldedDoc, path: &str) -> Option<String> {
    let document = DocumentRegistry::new("import", Arc::new(|_: &str, _: &[u8]| {}))
        .get_or_open(&doc.doc_id)
        .and_then(|document| document.apply_durable_update(&doc.state).map(|()| document))
        .ok()?;
    let options = SerializeOptions {
        note_path: Some(path),
        ..SerializeOptions::default()
    };
    Converter::new(CalloutTypes::new(Vec::new()))
        .serialize_note_body(&document, BODY_FRAGMENT, &options)
        .map(|body| body.markdown)
}

#[cfg(test)]
#[path = "docs_tests.rs"]
mod tests;
