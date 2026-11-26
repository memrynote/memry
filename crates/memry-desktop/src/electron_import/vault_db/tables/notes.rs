//! `note_metadata`, `note_positions` and `note_snapshots`.
//!
//! Each `note_metadata` row becomes one `note` or `journal` record whose payload is the one
//! Electron's push builds for it: `buildNotePushPayload` (`note-handler-sync-helpers.ts:34-91`)
//! and the journal handler's `buildPushPayload` (`journal-handler.ts:257-293`). Both read the
//! vault file ([`super::note_file`]) and the note payload reads the `note_properties` and
//! `note_tags` copies in the Electron `index.db`, so the record holds what the file and the
//! index said and the first native open has nothing to change. Each row also gets its
//! `note_files` row.

use std::path::Path;

use memry_core::domain::property_values::indexed_value;
use memry_core::storage::import::{ImportNoteFile, ImportNoteSnapshot, ImportRecord};
use memry_core::storage::repositories::instants::to_epoch_ms;
use rusqlite::{Connection, OptionalExtension, Row};
use serde_json::{Map, Value};

use super::js_json;
use super::note_file::{journal_fields, note_fields};
use super::records::{malformed, parse_clock, records, text};
use super::row_dumps::{column, json_column, synced_at};
use super::{SourceDb, TableStats};
use crate::electron_import::vault_db::source::source_error;
use crate::electron_import::vault_db::{ImportError, TableCtx, read_source_id};

const TABLE: &str = "note_metadata";

/// `note-cover-sync.ts:150`: the cover this device and the server last agreed on.
const COVER_MARKER_PREFIX: &str = "note-cover:";

/// The `note_metadata` columns a payload reads, in one row.
struct NoteRow {
    id: String,
    path: String,
    title: String,
    file_type: String,
    journal_date: Option<String>,
    /// Electron's next push of the row is a queued `create`, whose payload carries the body.
    create: bool,
}

pub fn note_metadata(ctx: &mut TableCtx<'_>) -> Result<TableStats, ImportError> {
    let (data, index, vault) = (ctx.source, ctx.index, ctx.vault_dir);
    let queued_creates = super::queue::queued_creates(data)?;
    let mut files = Vec::new();
    let mut pins = Vec::new();
    let mut unread = 0u64;
    let mut stats = records(
        ctx,
        "SELECT rowid, id, path, title, emoji, file_type, mime_type, file_size, attachment_id, \
         attachment_references, local_only, journal_date, clock, synced_at, created_at, \
         modified_at FROM note_metadata",
        |row, rowid| {
            let local_only = match column(row, "local_only", TABLE, rowid)? {
                Value::Number(n) => n.as_i64() != Some(0),
                _ => return Err(malformed(TABLE, rowid, "local_only is not an integer")),
            };
            let id = read_source_id(row, SourceDb::Data, TABLE, "id")?;
            let journal_date = text(row, "journal_date")?;
            // Electron's push sends the body only for a queued `create`: the one its seed of
            // unclocked rows queues (`seedUnclockedNotes`, `journal-handler.ts:299-317`), or one
            // still in `sync_queue`, its rows folded (`queue::queued_creates`). `synced_at` does
            // not say: a day pushed from this device is never marked synced, and an offline edit
            // clears it on a row the server holds.
            let seeded = text(row, "clock")?.is_none() && (journal_date.is_some() || !local_only);
            let create = seeded || queued_creates.contains(&id);
            let note = NoteRow {
                id,
                path: required_text(row, "path", rowid)?,
                title: required_text(row, "title", rowid)?,
                file_type: required_text(row, "file_type", rowid)?,
                journal_date,
                create,
            };
            files.push(ImportNoteFile {
                note_id: note.id.clone(),
                path: note.path.clone(),
                file_type: note.file_type.clone(),
                mime_type: text(row, "mime_type")?,
                file_size: row
                    .get("file_size")
                    .map_err(|_| malformed(TABLE, rowid, "file_size is not an integer"))?,
                local_only,
            });
            let (item_type, mut payload) = match &note.journal_date {
                Some(date) => ("journal", journal_payload(vault, &note, date, &mut unread)?),
                None if note.file_type != "markdown" => {
                    ("note", binary_payload(row, &note, rowid)?)
                }
                None => {
                    pins.extend(pinned_at(index, &note.id)?);
                    (
                        "note",
                        note_payload(row, (data, index, vault), &note, rowid, &mut unread)?,
                    )
                }
            };
            // `clock: cached.clock ?? {}`. An unclocked row keeps no clock (a departure), so
            // the seed of unclocked notes finds it as Electron's `seedUnclockedNotes` does.
            if let Some(clock) = parse_clock(text(row, "clock")?.as_deref(), TABLE, rowid)? {
                payload.insert("clock".into(), clock);
            }
            payload.insert("createdAt".into(), column(row, "created_at", TABLE, rowid)?);
            payload.insert(
                "modifiedAt".into(),
                column(row, "modified_at", TABLE, rowid)?,
            );
            Ok(ImportRecord {
                item_type,
                item_id: note.id,
                payload: js_json::stringify(&Value::Object(payload)),
                synced_at: synced_at(row, TABLE, rowid)?,
            })
        },
    )?;
    ctx.writer.put_note_files(&files, ctx.now_ms)?;
    ctx.writer.put_pinned_at(&pins)?;
    if unread > 0 {
        stats.notices.push(("unreadNoteFiles", unread));
    }
    Ok(stats)
}

fn required_text(row: &Row<'_>, name: &str, rowid: i64) -> Result<String, ImportError> {
    text(row, name)?.ok_or_else(|| malformed(TABLE, rowid, "a NOT NULL text column is null"))
}

/// `path.dirname(path)`, `.` as `null` (`note-sync.ts:121-124`).
fn folder_path(path: &str) -> Value {
    let trimmed = path.trim_end_matches('/');
    match trimmed.rfind('/') {
        None if path.starts_with('/') => Value::from("/"),
        None => Value::Null,
        Some(0) => Value::from("/"),
        Some(end) => Value::from(&trimmed[..end]),
    }
}

/// The payload of a binary file (`note-handler-sync-helpers.ts:40-52`), without its clock and
/// instants.
fn binary_payload(
    row: &Row<'_>,
    note: &NoteRow,
    rowid: i64,
) -> Result<Map<String, Value>, ImportError> {
    let mut payload = Map::new();
    payload.insert("title".into(), Value::from(note.title.clone()));
    payload.insert("emoji".into(), column(row, "emoji", TABLE, rowid)?);
    payload.insert("fileType".into(), Value::from(note.file_type.clone()));
    payload.insert("mimeType".into(), column(row, "mime_type", TABLE, rowid)?);
    payload.insert(
        "attachmentId".into(),
        column(row, "attachment_id", TABLE, rowid)?,
    );
    payload.insert("folderPath".into(), folder_path(&note.path));
    Ok(payload)
}

/// The payload of a markdown note (`note-handler-sync-helpers.ts:54-90`), without its clock
/// and instants. A file that could not be read adds one to `unread`.
fn note_payload(
    row: &Row<'_>,
    (data, index, vault): (&Connection, &Connection, &Path),
    note: &NoteRow,
    rowid: i64,
    unread: &mut u64,
) -> Result<Map<String, Value>, ImportError> {
    let fields = note_fields(vault, &note.id, &note.path, &note.title, note.create);
    *unread += u64::from(fields.is_none());
    let mut payload = Map::new();
    payload.insert("title".into(), Value::from(note.title.clone()));
    let (content, tags) = fields
        .as_ref()
        .map_or((None, Value::Array(Vec::new())), |f| {
            (f.content.clone(), f.tags.clone())
        });
    payload.insert("content".into(), Value::from(content));
    payload.insert("tags".into(), tags);
    // An unread file leaves `aliases` out, so a peer keeps its own (§13.7.1).
    if let Some(fields) = &fields {
        payload.insert("aliases".into(), Value::from(fields.aliases.clone()));
    }
    payload.insert(
        "properties".into(),
        Value::Object(properties(index, &note.id)?),
    );
    payload.insert(
        "pinnedTags".into(),
        Value::from(pinned_tags(index, &note.id)?),
    );
    payload.insert("emoji".into(), column(row, "emoji", TABLE, rowid)?);
    payload.insert("fileType".into(), Value::from(note.file_type.clone()));
    payload.insert("folderPath".into(), folder_path(&note.path));
    // `cached.attachmentReferences?.length`: a list with items.
    match json_column(row, "attachment_references", TABLE, rowid)? {
        Value::Array(items) if items.is_empty() => {}
        Value::Null => {}
        references => {
            payload.insert("attachmentReferences".into(), references);
        }
    }
    // `noteCoverForPush`, only for a file that was read. Its marker writes are not repeated:
    // the `note-cover:` rows are carried by the sync state import (36c).
    if let Some(fields) = fields {
        match fields.cover {
            Some(cover) => {
                payload.insert("cover".into(), Value::Object(cover));
            }
            None if cover_marker(data, &note.id)? => {
                payload.insert("cover".into(), Value::Null);
                payload.insert("coverImage".into(), Value::Null);
            }
            None => {}
        }
    }
    Ok(payload)
}

/// The day's payload (`journal-handler.ts:257-293`), without its clock and instants. The file is
/// the one Electron reads, at the vault config's path for the day. A file that could not be read
/// adds one to `unread`.
fn journal_payload(
    vault: &Path,
    note: &NoteRow,
    date: &str,
    unread: &mut u64,
) -> Result<Map<String, Value>, ImportError> {
    let fields = match crate::journal::day_path(vault, date) {
        Ok(rel) => journal_fields(vault, &note.id, &rel, date, note.create),
        Err(error) => {
            tracing::warn!(note_id = %note.id, %error, "electron import: a day has no file path");
            None
        }
    };
    *unread += u64::from(fields.is_none());
    let mut payload = Map::new();
    payload.insert("date".into(), Value::from(date));
    match &fields {
        Some(fields) => {
            payload.insert("content".into(), Value::from(fields.content.clone()));
            payload.insert("tags".into(), fields.tags.clone());
            payload.insert("properties".into(), fields.properties.clone());
            payload.insert("aliases".into(), Value::from(fields.aliases.clone()));
        }
        None => {
            payload.insert("content".into(), Value::Null);
            payload.insert("tags".into(), Value::Array(Vec::new()));
            payload.insert("properties".into(), Value::Null);
        }
    }
    Ok(payload)
}

fn index_error(error: rusqlite::Error) -> ImportError {
    source_error(SourceDb::Index, error)
}

/// `propsToRecord(getNoteProperties(indexDb, id))` (`property-queries.ts:83-98`).
fn properties(index: &Connection, note_id: &str) -> Result<Map<String, Value>, ImportError> {
    let mut stmt = index
        .prepare_cached(
            "SELECT name, value, type FROM note_properties WHERE note_id = ?1 ORDER BY rowid",
        )
        .map_err(index_error)?;
    let rows = stmt
        .query_map([note_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(index_error)?;
    let mut out = Map::new();
    for row in rows {
        let (name, value, type_name) = row.map_err(index_error)?;
        let value = value.map_or(Value::Null, |text| indexed_value(text, &type_name));
        out.insert(name, value);
    }
    Ok(out)
}

/// `getPinnedTagsForNote` (`note-pin-helpers.ts:6-13`), with drizzle's SQL, so SQLite returns
/// the tags in the order it gave Electron.
fn pinned_tags(index: &Connection, note_id: &str) -> Result<Vec<String>, ImportError> {
    let mut stmt = index
        .prepare_cached(
            "select \"tag\" from \"note_tags\" where (\"note_tags\".\"note_id\" = ?1 and \
             \"note_tags\".\"pinned_at\" is not null)",
        )
        .map_err(index_error)?;
    stmt.query_map([note_id], |row| row.get(0))
        .map_err(index_error)?
        .collect::<Result<_, _>>()
        .map_err(index_error)
}

/// The instant Electron pinned each tag, for the core's pinned order. A value that does not read
/// as an ISO instant keeps the projection's.
fn pinned_at(index: &Connection, note_id: &str) -> Result<Vec<(String, String, i64)>, ImportError> {
    let mut stmt = index
        .prepare_cached(
            "SELECT tag, pinned_at FROM note_tags WHERE note_id = ?1 AND pinned_at IS NOT NULL",
        )
        .map_err(index_error)?;
    let rows = stmt
        .query_map([note_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(index_error)?;
    let mut out = Vec::new();
    for row in rows {
        let (tag, at) = row.map_err(index_error)?;
        match to_epoch_ms(&at) {
            Some(ms) => out.push((note_id.to_owned(), tag, ms)),
            None => tracing::warn!(
                note_id,
                tag,
                "electron import: a pinned tag's instant is not ISO; kept as now"
            ),
        }
    }
    Ok(out)
}

/// Whether this device held a cover for the note (`readCoverMarker`).
fn cover_marker(data: &Connection, note_id: &str) -> Result<bool, ImportError> {
    let value: Option<Option<String>> = data
        .query_row(
            "SELECT value FROM sync_state WHERE key = ?1",
            [format!("{COVER_MARKER_PREFIX}{note_id}")],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| source_error(SourceDb::Data, e))?;
    Ok(matches!(
        value.flatten().as_deref(),
        Some("present" | "removal-pending")
    ))
}

/// `note_positions`, unchanged (Step 13's table has the same three columns).
pub fn note_positions(ctx: &mut TableCtx<'_>) -> Result<TableStats, ImportError> {
    const TABLE: &str = "note_positions";
    let rows = {
        let mut stmt = ctx
            .source
            .prepare("SELECT rowid, path, folder_path, position FROM note_positions")
            .map_err(|e| source_error(SourceDb::Data, e))?;
        let mut rows = stmt
            .query([])
            .map_err(|e| source_error(SourceDb::Data, e))?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().map_err(|e| source_error(SourceDb::Data, e))? {
            let rowid: i64 = row
                .get("rowid")
                .map_err(|e| source_error(SourceDb::Data, e))?;
            let folder = text(row, "folder_path")?
                .ok_or_else(|| malformed(TABLE, rowid, "folder_path is null"))?;
            let position: i64 = row
                .get("position")
                .map_err(|_| malformed(TABLE, rowid, "position is not an integer"))?;
            out.push((
                read_source_id(row, SourceDb::Data, TABLE, "path")?,
                folder,
                position,
            ));
        }
        out
    };
    ctx.writer.put_note_positions(&rows)?;
    Ok(TableStats {
        written: rows.len() as u64,
        dropped: Vec::new(),
        notices: Vec::new(),
    })
}

/// `note_snapshots` of the Electron `index.db` into the core table with identical values; a
/// snapshot of a note the import has no row for is dropped and counted.
pub fn note_snapshots(ctx: &mut TableCtx<'_>) -> Result<TableStats, ImportError> {
    const TABLE: &str = "note_snapshots";
    let notes = ctx.writer.note_ids()?;
    let (mut kept, mut orphans) = (Vec::new(), 0u64);
    {
        let mut stmt = ctx
            .source
            .prepare(
                "SELECT rowid, id, note_id, content, title, word_count, content_hash, reason, \
                 created_at FROM note_snapshots ORDER BY rowid",
            )
            .map_err(index_error)?;
        let mut rows = stmt.query([]).map_err(index_error)?;
        while let Some(row) = rows.next().map_err(index_error)? {
            let rowid: i64 = row.get("rowid").map_err(index_error)?;
            let get = |name: &str| -> Result<String, ImportError> {
                match row.get_ref(name).map_err(index_error)? {
                    rusqlite::types::ValueRef::Text(bytes) => String::from_utf8(bytes.to_vec())
                        .map_err(|_| malformed(TABLE, rowid, "a text column is not UTF-8")),
                    _ => Err(malformed(TABLE, rowid, "a text column holds no text")),
                }
            };
            let snapshot = ImportNoteSnapshot {
                id: read_source_id(row, SourceDb::Index, TABLE, "id")?,
                note_id: read_source_id(row, SourceDb::Index, TABLE, "note_id")?,
                content: get("content")?,
                title: get("title")?,
                word_count: row
                    .get("word_count")
                    .map_err(|_| malformed(TABLE, rowid, "word_count is not an integer"))?,
                content_hash: get("content_hash")?,
                reason: get("reason")?,
                created_at: get("created_at")?,
            };
            match notes.contains(&snapshot.note_id) {
                true => kept.push(snapshot),
                false => orphans += 1,
            }
        }
    }
    ctx.writer.put_note_snapshots(&kept)?;
    Ok(TableStats {
        written: kept.len() as u64,
        dropped: match orphans {
            0 => Vec::new(),
            n => vec![("snapshotsWithoutNote", n)],
        },
        notices: Vec::new(),
    })
}
