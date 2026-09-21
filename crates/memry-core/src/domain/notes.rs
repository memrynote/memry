//! Notes: create, rename, move, delete (T126, FR-051's sibling FR-038,
//! chapter 13 §13.7.1, data-model §A.4).
//!
//! **This module also holds the local-write seam the other three record-shaped
//! modules of this wave share** — [`insert_local`], [`edit`],
//! [`tombstone_local`] and the two stamps they need. The repository tier owns
//! the merge for a row that already exists
//! ([`sync_items::apply_local_edit_in`]) and nothing for a row that does not,
//! so the create half lives here. It is written once rather than four times
//! because `folder_config`, `template` and `journal` create rows with exactly
//! the same obligations, and a second copy is a second place for a payload to
//! be written without its outbox row.
//!
//! Three obligations shape every function below.
//!
//! - **One transaction.** A merged payload without its outbox row is a local
//!   edit no peer ever sees (FR-030, data-model §A.2), so the source write and
//!   [`outbox::enqueue`] commit together. [`outbox::commit`] is that
//!   transaction for a write that queues exactly one change, and the
//!   [`outbox::Durable`] it hands back is minted only after `COMMIT` returned
//!   (§C.4, durable before acknowledged).
//! - **One set of payload bytes.** A create serialises the object it was given
//!   and stores *that*; an edit merges into the parsed copy and stores *that*
//!   (§13.2 rule 3). No projection row is ever an input (§13.2 rule 4), and
//!   there is no `#[derive(Deserialize)]` payload struct here for the reason
//!   [`crate::storage::repositories`] gives at length (#2183).
//! - **No markdown.** `content` on a create is carried **verbatim** into the
//!   payload and into `note_bodies.seed_markdown`; the editor bundle is the
//!   only thing that turns it into a document (chapter 12 §12.1.2, §12.2
//!   carve-out A, data-model §A.3). The core parses none of it.
//!
//! `_offline` never reaches a payload written here: [`next_clock`] refuses the
//! reserved device id outright, which is §6.6 made structural rather than
//! remembered.

use rusqlite::{Connection, OptionalExtension as _, params};
use serde_json::{Value, json};
use sha2::{Digest as _, Sha256};

use crate::api::errors::StorageError;
use crate::storage::repositories::schema::Object;
use crate::storage::repositories::{
    Change, StoredPayload, instants, projectors,
    projectors::ItemContext,
    sync_items::{self, PAYLOAD_STATE_FULL},
};
use crate::sync::clock::{self, OFFLINE_CLOCK_DEVICE_ID, VectorClock};
use crate::sync::outbox::{self, Durable};

/// The `(type, _)` half of every key this module writes.
pub const ITEM_TYPE: &str = "note";

/// `NoteIdSchema`: `/^[a-zA-Z0-9_-]+$/`, capped at 128 (chapter 07 §7.1).
///
/// A note id is also its CRDT document id, so an id the CRDT routes reject is
/// a note whose body can never be pushed. It is checked at creation, which is
/// the only moment the core mints nothing and accepts what it is handed.
pub const MAX_DOCUMENT_ID_LEN: usize = 128;

/// What a new note carries.
///
/// `content` is chapter 12 §12.2's carve-out A: the body **does** travel in a
/// create record, and desktop writes it to the vault file verbatim. Send `""`
/// unless seeding from a template — the Y.Doc pushed alongside is
/// authoritative, and create-time `content` is best-effort by §12.2's own
/// words.
#[derive(Debug, Clone, Copy)]
pub struct NewNote<'a> {
    pub id: &'a str,
    pub title: &'a str,
    /// `None` is the vault root, written as an explicit `null` (§13.4).
    pub folder_path: Option<&'a str>,
    pub content: &'a str,
    pub tags: &'a [String],
    /// §13.7.1's free-form values record. Empty means the key is **absent**
    /// rather than an empty object: §13.4 makes those different writes, and a
    /// note that has never had a property has not cleared one.
    pub properties: Option<&'a Object>,
}

/// Creates a note, its payload and its body row.
pub fn create(
    conn: &Connection,
    note: &NewNote<'_>,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<String>, StorageError> {
    outbox::commit(
        conn,
        &outbox::Change::upsert(ITEM_TYPE, note.id),
        now_ms,
        |tx| create_in(tx, note, device_id, now_ms),
    )
}

/// Retitles a note.
pub fn rename(
    conn: &Connection,
    note_id: &str,
    title: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<String>, StorageError> {
    edit(
        conn,
        ITEM_TYPE,
        note_id,
        vec![("title", Change::set(title))],
        device_id,
        now_ms,
    )
}

/// Moves a note to `folder_path`, or to the vault root with `None`.
///
/// The root is an explicit `null`, not an absent key: absent means "the sender
/// does not know this field" and the receiver keeps its own value (§13.4), so
/// dropping the key would leave the note where it was on every other device.
pub fn move_to_folder(
    conn: &Connection,
    note_id: &str,
    folder_path: Option<&str>,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<String>, StorageError> {
    let target = match folder_path {
        Some(path) => Value::String(super::folders::valid_path(path)?.to_owned()),
        None => Value::Null,
    };
    edit(
        conn,
        ITEM_TYPE,
        note_id,
        vec![("folderPath", Change::Set(target))],
        device_id,
        now_ms,
    )
}

/// Adds an attachment id to a note's `attachmentReferences` (§14.7).
///
/// **A union, never a replace.** A note can embed several attachments and each
/// upload lands separately, so replacing the list drops every id but the last
/// — which is the bug desktop's own `recordUploadedAttachment` carries a
/// comment about. It is also what §13.4 asks for on a field whose absence
/// means "this sender does not know": a merge cannot lose what another device
/// knew and this one did not.
///
/// Returns without writing when the id is already there, so a retried upload
/// does not enqueue a second push of an unchanged note.
pub fn add_attachment_reference(
    conn: &Connection,
    note_id: &str,
    attachment_id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Option<Durable<String>>, StorageError> {
    let existing: Vec<String> = read_attachment_references(conn, note_id)?;
    if existing.iter().any(|id| id == attachment_id) {
        return Ok(None);
    }
    let mut merged = existing;
    merged.push(attachment_id.to_owned());
    Ok(Some(edit(
        conn,
        ITEM_TYPE,
        note_id,
        vec![(
            "attachmentReferences",
            Change::Set(Value::Array(
                merged.into_iter().map(Value::String).collect(),
            )),
        )],
        device_id,
        now_ms,
    )?))
}

/// Removes an attachment id from a note's `attachmentReferences`.
///
/// The one place a **positive** removal is correct: the user deleted the
/// picture, so this device has evidence of absence rather than silence. That
/// is what makes it different from an absent key, which must never prune.
pub fn remove_attachment_reference(
    conn: &Connection,
    note_id: &str,
    attachment_id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Option<Durable<String>>, StorageError> {
    let existing = read_attachment_references(conn, note_id)?;
    if !existing.iter().any(|id| id == attachment_id) {
        return Ok(None);
    }
    let remaining: Vec<Value> = existing
        .into_iter()
        .filter(|id| id != attachment_id)
        .map(Value::String)
        .collect();
    Ok(Some(edit(
        conn,
        ITEM_TYPE,
        note_id,
        vec![("attachmentReferences", Change::Set(Value::Array(remaining)))],
        device_id,
        now_ms,
    )?))
}

/// The note's current reference list, or empty when the column is null.
///
/// Empty here means "this row carries none", which is the local fact. It is
/// **not** the protocol's "the sender does not know" — that distinction lives
/// on the wire, and §14.7 keeps it there.
pub fn read_attachment_references(
    conn: &Connection,
    note_id: &str,
) -> Result<Vec<String>, StorageError> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT attachment_references FROM notes WHERE id = ?1 AND deleted_at IS NULL",
            params![note_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| StorageError::Failed {
            what: error.to_string(),
        })?
        .flatten();
    Ok(raw
        .as_deref()
        .and_then(|json| serde_json::from_str::<Vec<String>>(json).ok())
        .unwrap_or_default())
}

/// Tombstones a note.
pub fn delete(
    conn: &Connection,
    note_id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<()>, StorageError> {
    outbox::commit(
        conn,
        &outbox::Change::delete(ITEM_TYPE, note_id),
        now_ms,
        |tx| tombstone_local(tx, ITEM_TYPE, note_id, device_id, now_ms),
    )
}

/// [`create`] without the transaction, so template application can create the
/// note and read the template it seeds from as one unit.
pub(crate) fn create_in(
    tx: &Connection,
    note: &NewNote<'_>,
    device_id: &str,
    now_ms: i64,
) -> Result<String, StorageError> {
    valid_document_id(note.id)?;
    let at = iso(now_ms)?;
    let mut payload = object(json!({
        "title": note.title,
        "content": note.content,
        "fileType": "markdown",
        "folderPath": note.folder_path,
        "clock": next_clock(&Object::new(), device_id)?,
        "createdAt": at,
        "modifiedAt": at,
    }));
    if !note.tags.is_empty() {
        payload.insert("tags".to_owned(), json!(note.tags));
    }
    if let Some(properties) = note.properties.filter(|values| !values.is_empty()) {
        payload.insert("properties".to_owned(), Value::Object(properties.clone()));
    }
    let stored = insert_local(tx, ITEM_TYPE, note.id, payload, now_ms)?;
    seed_body(tx, note.id, note.content, now_ms)?;
    Ok(stored)
}

/// A local edit to one row: stamp it, merge it, queue it, commit once.
pub(crate) fn edit(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
    changes: Vec<(&'static str, Change)>,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<String>, StorageError> {
    outbox::commit(
        conn,
        &outbox::Change::upsert(item_type, item_id),
        now_ms,
        |tx| {
            let mut merged = stamp(tx, item_type, item_id, device_id, now_ms)?;
            merged.extend(changes);
            sync_items::apply_local_edit_in(tx, item_type, item_id, &merged, now_ms)
        },
    )
}

/// Writes a row that does not exist yet: the create half of §13.2 rule 3.
///
/// There is **one** set of payload bytes — the ones serialised here — and the
/// projection is downstream of them: the stored string is parsed back and read
/// through the type's own reader before anything is projected, so a local
/// create that could not be read back fails loudly instead of landing as a
/// corrupt row on every device in the vault.
pub(crate) fn insert_local(
    tx: &Connection,
    item_type: &str,
    item_id: &str,
    payload: Object,
    now_ms: i64,
) -> Result<String, StorageError> {
    if tx.is_autocommit() {
        return Err(StorageError::Failed {
            what: "a local create must be written in the same transaction as its outbox row \
                   (FR-030, data-model §A.2, chapter 13 §13.2)"
                .to_owned(),
        });
    }
    if sync_items::load(tx, item_type, item_id)?.is_some() {
        return Err(StorageError::Failed {
            what: format!("sync item {item_type}/{item_id} already exists"),
        });
    }

    let raw = serde_json::to_string(&Value::Object(payload))
        .expect("a Map<String, Value> always serialises");
    let parsed = StoredPayload::parse(&raw).map_err(refuse(item_type, item_id))?;
    let view = projectors::read(item_type, parsed.object()).map_err(refuse(item_type, item_id))?;

    tx.execute(
        "INSERT INTO sync_items (
             item_type, item_id, payload, payload_state, clock, field_clocks, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            item_type,
            item_id,
            raw,
            PAYLOAD_STATE_FULL,
            projectors::clock_text(&view),
            projectors::field_clocks_text(&view),
            now_ms,
        ],
    )
    .map_err(failed)?;
    projectors::project(
        tx,
        item_type,
        ItemContext {
            item_id,
            synced_at: now_ms,
            deleted_at: None,
        },
        &view,
    )?;
    Ok(raw)
}

/// Marks a row deleted and refreshes its projection through the same merge
/// every other edit uses.
///
/// The tombstone is written **before** the merge so that
/// [`sync_items::apply_local_edit_in`] reads it back and projects it: the
/// projection row is a cache of a parse plus the item's own bookkeeping, and
/// `deleted_at` is the bookkeeping half.
pub(crate) fn tombstone_local(
    tx: &Connection,
    item_type: &str,
    item_id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    let Some(row) = sync_items::load(tx, item_type, item_id)? else {
        return Err(StorageError::Failed {
            what: format!("no sync item {item_type}/{item_id} to delete"),
        });
    };
    tx.execute(
        "UPDATE sync_items SET deleted_at = ?3, updated_at = ?3
         WHERE item_type = ?1 AND item_id = ?2",
        params![item_type, item_id, now_ms],
    )
    .map_err(failed)?;

    if row.payload.is_none() {
        // Metadata only: there is nothing to merge into and nothing to
        // project. The row is still flagged, so the delete pushes.
        return Ok(());
    }
    let changes = stamp(tx, item_type, item_id, device_id, now_ms)?;
    sync_items::apply_local_edit_in(tx, item_type, item_id, &changes, now_ms)?;
    Ok(())
}

/// The two keys every local edit carries: the advanced clock and `modifiedAt`.
///
/// Advancing the clock is not optional on any type this wave owns — all four
/// are resolved document-level (§13.9), so an edit that left the clock alone
/// would lose to a peer's older payload.
pub(crate) fn stamp(
    tx: &Connection,
    item_type: &str,
    item_id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Vec<(&'static str, Change)>, StorageError> {
    let stored = require_payload(tx, item_type, item_id)?;
    Ok(vec![
        (
            "clock",
            Change::Set(next_clock(stored.object(), device_id)?),
        ),
        ("modifiedAt", Change::set(iso(now_ms)?)),
    ])
}

/// The stored payload of a row that must have one.
pub(crate) fn require_payload(
    tx: &Connection,
    item_type: &str,
    item_id: &str,
) -> Result<StoredPayload, StorageError> {
    let Some(row) = sync_items::load(tx, item_type, item_id)? else {
        return Err(StorageError::Failed {
            what: format!("no sync item {item_type}/{item_id}"),
        });
    };
    let Some(stored) = row.payload else {
        return Err(StorageError::Failed {
            what: format!(
                "sync item {item_type}/{item_id} has no payload yet; pull its body before editing it"
            ),
        });
    };
    StoredPayload::parse(&stored).map_err(refuse(item_type, item_id))
}

/// `clock` with this device's tick advanced by one (§6.1).
///
/// A stored `clock` that is not a vector clock is a **hard error**: reading it
/// as an empty clock would restart this device's tick at 1 and hand every
/// concurrent peer the win. `_offline` is refused as a device id outright —
/// a clock carrying it MUST never reach the server (§6.6), and the core has no
/// code path that can write one.
pub(crate) fn next_clock(stored: &Object, device_id: &str) -> Result<Value, StorageError> {
    if device_id.is_empty() || device_id == OFFLINE_CLOCK_DEVICE_ID {
        return Err(StorageError::Failed {
            what: format!("`{device_id}` is not a usable device id (chapter 06 §6.6)"),
        });
    }
    let current: VectorClock = match stored.get("clock") {
        None | Some(Value::Null) => VectorClock::new(),
        Some(value) => {
            serde_json::from_value(value.clone()).map_err(|error| StorageError::Failed {
                what: format!("stored clock is not a vector clock: {error}"),
            })?
        }
    };
    serde_json::to_value(clock::increment(&current, device_id)).map_err(|error| {
        StorageError::Failed {
            what: format!("clock will not serialise: {error}"),
        }
    })
}

/// An instant in the string shape a conforming client emits (§13.5).
pub(crate) fn iso(now_ms: i64) -> Result<String, StorageError> {
    instants::to_iso8601(now_ms).ok_or_else(|| StorageError::Failed {
        what: format!("{now_ms} is outside the representable instant range"),
    })
}

/// `NoteIdSchema`, chapter 07 §7.1.
pub(crate) fn valid_document_id(id: &str) -> Result<&str, StorageError> {
    let ok = !id.is_empty()
        && id.len() <= MAX_DOCUMENT_ID_LEN
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-');
    if ok {
        Ok(id)
    } else {
        Err(StorageError::Failed {
            what: format!(
                "`{id}` is not a document id: /^[a-zA-Z0-9_-]+$/ capped at \
                 {MAX_DOCUMENT_ID_LEN} (chapter 07 §7.1)"
            ),
        })
    }
}

/// The body row a new note starts with (data-model §A.3).
///
/// `text` is empty because it is derived from the Yjs log and there is no log
/// yet; deriving it from the markdown would be parsing markdown, which this
/// tier does not do. `seed_markdown` is the other half: until the editor has
/// seeded the document it is the **only** copy of what the user asked for, so
/// a phone killed between "create from template" and the first editor open
/// still has the template's content on next launch.
pub(crate) fn seed_body(
    tx: &Connection,
    note_id: &str,
    markdown: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    let text = "";
    let digest = hex::encode(Sha256::digest(text.as_bytes()));
    let seed = (!markdown.is_empty()).then_some(markdown);
    tx.execute(
        "INSERT INTO note_bodies (
             note_id, text, seed_markdown, text_sha256, source_seq, materialised_at
         ) VALUES (?1, ?2, ?3, ?4, NULL, ?5)
         ON CONFLICT(note_id) DO UPDATE SET
             seed_markdown = excluded.seed_markdown,
             materialised_at = excluded.materialised_at",
        params![note_id, text, seed, digest, now_ms],
    )
    .map_err(failed)?;
    Ok(())
}

/// The object half of a `json!` literal this module built itself.
pub(crate) fn object(value: Value) -> Object {
    match value {
        Value::Object(map) => map,
        other => unreachable!("a json! object literal is an object, got {other}"),
    }
}

pub(crate) fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

/// A local write that cannot be read back is a bug in this build, not a
/// remote's problem, so it fails loudly instead of storing bytes no reader
/// accepts.
fn refuse(
    item_type: &str,
    item_id: &str,
) -> impl FnOnce(crate::storage::repositories::ProjectionError) -> StorageError {
    let item_type = item_type.to_owned();
    let item_id = item_id.to_owned();
    move |error| StorageError::Failed {
        what: format!("local write to {item_type}/{item_id} would not read back: {error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_document_id_follows_the_crdt_route_s_own_grammar() {
        assert!(valid_document_id("dzxnhc9p3gk3").is_ok());
        assert!(valid_document_id("j2026-04-16").is_ok());
        assert!(valid_document_id("").is_err());
        assert!(valid_document_id("has space").is_err());
        assert!(valid_document_id("slash/es").is_err());
        assert!(valid_document_id(&"a".repeat(MAX_DOCUMENT_ID_LEN + 1)).is_err());
    }

    #[test]
    fn the_first_local_edit_ticks_this_device_to_one() {
        let clock = next_clock(&Object::new(), "device-a").expect("a clock");
        assert_eq!(clock, json!({"device-a": 1}));
    }

    #[test]
    fn an_existing_tick_advances_and_every_other_device_is_kept() {
        let stored = object(json!({"clock": {"device-a": 2, "device-b": 9}}));
        assert_eq!(
            next_clock(&stored, "device-a").expect("a clock"),
            json!({"device-a": 3, "device-b": 9})
        );
    }

    #[test]
    fn a_clock_that_will_not_parse_is_an_error_and_never_an_empty_clock() {
        let stored = object(json!({"clock": {"device-a": "two"}}));
        assert!(next_clock(&stored, "device-a").is_err());
    }

    #[test]
    fn the_reserved_offline_id_is_refused_before_it_can_reach_a_payload() {
        assert!(next_clock(&Object::new(), OFFLINE_CLOCK_DEVICE_ID).is_err());
        assert!(next_clock(&Object::new(), "").is_err());
    }
}
