//! `note` and `journal`, and the `note_tags` side rows both feed
//! (chapter 13 §13.7.1, §13.7.2, data-model §A.4).
//!
//! `content` is projected nowhere. The body lives in the CRDT log and in
//! `note_bodies`, and a record push for an update carries `content: null`
//! (§13.7.1), so a `notes.content` column would be a cache of a value the wire
//! deliberately stops sending.
//!
//! Both types carry `SyncTimestampSchema` on `createdAt` and `modifiedAt`, and
//! they are the only two that do (§13.5). The union exists because the phone
//! wrote `Date.now()` where the schema said string; six notes in one staging
//! vault were accepted by the server, counted as synced, and silently applied
//! nowhere before it was noticed. It is permanent and strictly a widening.
//!
//! Null tolerance in the field table below follows [`super`]'s rule: an
//! optional field is `opt_null`, because a projector substitutes and never
//! refuses (§13.3, §A.4, spec-defect 53).

use rusqlite::{Connection, params};

use crate::api::errors::StorageError;

use super::super::schema::{Field, Kind, Object, ProjectionError, read_fields};
use super::{ItemContext, clock_text, failed, instant, json, strings, text, text_or_default};

/// §13.7.1. `markdown | pdf | image | audio | video`; a binary type has no CRDT
/// body.
const FILE_TYPES: &[&str] = &["markdown", "pdf", "image", "audio", "video"];

const NOTE_FIELDS: &[Field] = &[
    Field::opt_null("title", Kind::Text),
    Field::opt_null("content", Kind::Text),
    Field::opt_null("tags", Kind::TextArray),
    Field::opt_null("pinnedTags", Kind::TextArray),
    Field::opt_null("emoji", Kind::Text),
    // Free-form: values only, never definitions. `property_definition` carries
    // those.
    Field::opt_null("properties", Kind::Object),
    Field::opt_null("aliases", Kind::TextArray),
    Field::opt_null("fileType", Kind::Enum(FILE_TYPES)),
    Field::opt_null("mimeType", Kind::Text),
    Field::opt_null("attachmentId", Kind::Text),
    Field::opt_null("attachmentReferences", Kind::TextArray),
    Field::opt_null("folderPath", Kind::Text),
    Field::opt_null("clock", Kind::Clock),
    Field::opt_null("createdAt", Kind::SyncTimestamp),
    Field::opt_null("modifiedAt", Kind::SyncTimestamp),
];

/// §13.7.2: the same shape as `note` minus the file fields, plus `date`.
///
/// `date` is optional **only** so a delete tombstone can omit it. A create or
/// update without it is refused by the handler rather than by the schema, which
/// is why it is not marked required here.
const JOURNAL_FIELDS: &[Field] = &[
    // The one field on any type deliberately left **not** null-tolerant. A
    // `null` here is not a tombstone (a delete never reaches this reader,
    // §13.7.2) and not a day either: `journal_entries.date` is NOT NULL
    // UNIQUE, so substituting would project no row at all and the entry would
    // vanish with nothing recorded. Refusing keeps the bytes and flags the
    // row, which is the outcome §13.2 rule 5 asks for when substitution has no
    // honest answer.
    Field::opt("date", Kind::Text),
    Field::opt_null("title", Kind::Text),
    Field::opt_null("content", Kind::Text),
    Field::opt_null("tags", Kind::TextArray),
    Field::opt_null("pinnedTags", Kind::TextArray),
    Field::opt_null("emoji", Kind::Text),
    Field::opt_null("properties", Kind::Object),
    Field::opt_null("aliases", Kind::TextArray),
    Field::opt_null("clock", Kind::Clock),
    Field::opt_null("createdAt", Kind::SyncTimestamp),
    Field::opt_null("modifiedAt", Kind::SyncTimestamp),
];

pub fn read_note(parsed: &Object) -> Result<Object, ProjectionError> {
    read_fields("note", parsed, NOTE_FIELDS)
}

pub fn read_journal(parsed: &Object) -> Result<Object, ProjectionError> {
    read_fields("journal", parsed, JOURNAL_FIELDS)
}

pub fn project_note(
    conn: &Connection,
    item: ItemContext<'_>,
    view: &Object,
) -> Result<(), StorageError> {
    conn.execute(
        "INSERT INTO notes (
             id, title, folder_path, emoji, file_type, mime_type, attachment_id,
             attachment_references, aliases, properties, created_at, modified_at,
             clock, synced_at, deleted_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
         ON CONFLICT(id) DO UPDATE SET
             title = excluded.title,
             folder_path = excluded.folder_path,
             emoji = excluded.emoji,
             file_type = excluded.file_type,
             mime_type = excluded.mime_type,
             attachment_id = excluded.attachment_id,
             attachment_references = excluded.attachment_references,
             aliases = excluded.aliases,
             properties = excluded.properties,
             created_at = excluded.created_at,
             modified_at = excluded.modified_at,
             clock = excluded.clock,
             synced_at = excluded.synced_at,
             deleted_at = excluded.deleted_at",
        params![
            item.item_id,
            text_or_default(view, "title", ""),
            text(view, "folderPath"),
            text(view, "emoji"),
            text_or_default(view, "fileType", "markdown"),
            text(view, "mimeType"),
            text(view, "attachmentId"),
            json(view, "attachmentReferences"),
            json(view, "aliases"),
            json(view, "properties"),
            instant(view, "createdAt"),
            instant(view, "modifiedAt"),
            clock_text(view),
            item.synced_at,
            item.deleted_at,
        ],
    )
    .map_err(failed)?;

    project_tags(conn, item, view)
}

pub fn project_journal(
    conn: &Connection,
    item: ItemContext<'_>,
    view: &Object,
) -> Result<(), StorageError> {
    let Some(date) = text(view, "date") else {
        // A tombstone omits `date` (§13.7.2), and `journal_entries.date` is
        // NOT NULL UNIQUE because FR-054 makes one row per calendar day
        // structural. Inventing a day for a tombstone would either collide
        // with the real row for that day or create a second one, so the
        // tombstone updates the existing row and writes nothing new.
        conn.execute(
            "UPDATE journal_entries SET synced_at = ?2, deleted_at = ?3 WHERE id = ?1",
            params![item.item_id, item.synced_at, item.deleted_at],
        )
        .map_err(failed)?;
        return Ok(());
    };

    conn.execute(
        "INSERT INTO journal_entries (
             id, date, properties, created_at, modified_at, clock, synced_at, deleted_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(id) DO UPDATE SET
             date = excluded.date,
             properties = excluded.properties,
             created_at = excluded.created_at,
             modified_at = excluded.modified_at,
             clock = excluded.clock,
             synced_at = excluded.synced_at,
             deleted_at = excluded.deleted_at",
        params![
            item.item_id,
            date,
            json(view, "properties"),
            instant(view, "createdAt"),
            instant(view, "modifiedAt"),
            clock_text(view),
            item.synced_at,
            item.deleted_at,
        ],
    )
    .map_err(failed)?;

    project_tags(conn, item, view)
}

/// `note_tags`, from the `tags` array on `note` and `journal` (§A.4).
///
/// The rows are replaced wholesale rather than diffed: the table is a cache of
/// a parse, so "what this payload says" is the whole truth for this item, and a
/// tag that left the array has no row rather than a tombstoned one.
///
/// `pinned_at` records membership of `pinnedTags`, not an instant the payload
/// carries — the payload has no such instant — so it holds the apply time of
/// the payload that pinned it.
fn project_tags(
    conn: &Connection,
    item: ItemContext<'_>,
    view: &Object,
) -> Result<(), StorageError> {
    conn.execute(
        "DELETE FROM note_tags WHERE note_id = ?1",
        params![item.item_id],
    )
    .map_err(failed)?;

    let pinned = strings(view, "pinnedTags");
    let clock = clock_text(view);
    for (position, tag) in strings(view, "tags").into_iter().enumerate() {
        let pinned_at = pinned.contains(&tag).then_some(item.synced_at);
        conn.execute(
            "INSERT INTO note_tags (note_id, tag, position, pinned_at, clock, synced_at, deleted_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(note_id, tag) DO UPDATE SET
                 position = excluded.position,
                 pinned_at = excluded.pinned_at,
                 clock = excluded.clock,
                 synced_at = excluded.synced_at,
                 deleted_at = excluded.deleted_at",
            params![
                item.item_id,
                tag,
                position as i64,
                pinned_at,
                clock,
                item.synced_at,
                item.deleted_at,
            ],
        )
        .map_err(failed)?;
    }
    Ok(())
}
