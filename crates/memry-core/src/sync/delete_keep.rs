//! Keeping text a pulled delete would erase unseen (#3029, chapter 05 §5.8
//! client behavior). Mirrors `keepsUnseenText` in
//! `packages/sync-client/src/delete-keep.ts`, pinned by `delete-keep.json`.
//!
//! Another device deleted a note or journal day while this device held text
//! it never received. The delete still wins, but first that text is saved as
//! a new inbox `note` capture with a fresh id. The copy is written inside the
//! tombstone's transaction, so it commits or rolls back with the delete; a
//! delete that arrives again finds the row already deleted and keeps nothing,
//! so there is one copy.
//!
//! The text counts as unseen when any of these holds (the TypeScript doc has
//! the reasoning):
//!
//! 1. a local change to the item is still in the outbox;
//! 2. the local record clock is concurrent with the tombstone;
//! 3. this device's latest own body update was written no earlier than the
//!    delete minus [`DELETE_KEEP_SKEW_MS`]. The core pulls before it pushes in
//!    a pass, so an edit made before the delete is still in the outbox when
//!    the delete is applied, unless it was pushed in an earlier pass;
//! 4. the tombstone carries the deleter's body state vector and this device's
//!    body log holds an item it does not cover (#3037).
//!
//! A note or journal day whose vault file holds bytes the document never took
//! (an outside edit the vault has not read yet) keeps that file's text
//! whatever the four rules say (#5758, #5796).
//!
//! The core never writes markdown, so the copy holds [`extract_text`]'s plain
//! text: words, headings and list markers, without inline formatting. A body
//! log with a blob that does not replay is read from the note's vault file,
//! as Electron reads every body, and else from the blobs that replay (#5343).

use std::path::Path;
use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use rusqlite::{Connection, OptionalExtension as _, params};
use yrs::StateVector;
use yrs::updates::decoder::Decode as _;

use crate::api::errors::StorageError;
use crate::crdt::CrdtError;
use crate::crdt::registry::{Document, DocumentRegistry, UpdateSink};
use crate::crdt::text_extract::extract_text;
use crate::crdt::update_log::{self, LOCAL_NAMESPACE_PREFIX};
use crate::domain::content_hash::content_hash;
use crate::domain::inbox::write::{NewCapture, capture_in};
use crate::domain::journal;
use crate::domain::journal_rules::canonical_journal_id;
use crate::domain::note_files;
use crate::storage::repositories::sync_items;

use super::clock::{ClockOrder, VectorClock, compare};

/// Slack for clock skew between the deleting device and this one.
pub const DELETE_KEEP_SKEW_MS: i64 = 60_000;

const READER_DEVICE_ID: &str = "memry-core-delete-keep";

/// The facts [`keeps_unseen_text`] decides on.
#[derive(Debug, Clone, Default)]
pub struct UnseenTextFacts {
    pub body_blank: bool,
    pub waiting_changes: bool,
    pub local_clock: Option<VectorClock>,
    pub tombstone_clock: Option<VectorClock>,
    /// The tombstone's `deletedAt` as it came off the wire.
    pub deleted_at: Option<i64>,
    /// Epoch ms of this device's latest own body text (rule 3).
    pub last_local_body_at: Option<i64>,
    /// Base64 Yjs v1 state vector the tombstone carries (`bodyStateVector`).
    pub deleter_body_state_vector: Option<String>,
    /// Base64 Yjs v1 state vector of this device's body log (rule 4).
    pub local_body_state_vector: Option<String>,
}

/// `deletedAtMs`: desktop sends whole seconds, the core sends ms.
pub fn deleted_at_ms(deleted_at: i64) -> i64 {
    if deleted_at < 100_000_000_000 {
        deleted_at * 1000
    } else {
        deleted_at
    }
}

/// `keepsUnseenText`.
pub fn keeps_unseen_text(facts: &UnseenTextFacts) -> bool {
    if facts.body_blank {
        return false;
    }
    let order = match (&facts.local_clock, &facts.tombstone_clock) {
        (Some(local), Some(tombstone)) => Some(compare(local, tombstone)),
        _ => None,
    };
    if order == Some(ClockOrder::After) {
        return false;
    }
    if facts.waiting_changes || order == Some(ClockOrder::Concurrent) {
        return true;
    }
    if let (Some(deleter), Some(local)) = (
        &facts.deleter_body_state_vector,
        &facts.local_body_state_vector,
    ) && !state_vector_covers(deleter, local)
    {
        return true;
    }
    match (facts.deleted_at, facts.last_local_body_at) {
        (Some(deleted_at), Some(last)) => last >= deleted_at_ms(deleted_at) - DELETE_KEEP_SKEW_MS,
        _ => false,
    }
}

/// `stateVectorCovers`: every Yjs client clock in `local` is at most the one
/// in `deleter`. A vector that does not decode covers nothing (rule 4 keeps).
pub fn state_vector_covers(deleter: &str, local: &str) -> bool {
    let decode = |text: &str| {
        BASE64
            .decode(text)
            .ok()
            .and_then(|bytes| StateVector::decode_v1(&bytes).ok())
    };
    let (Some(seen), Some(held)) = (decode(deleter), decode(local)) else {
        return false;
    };
    held.iter()
        .all(|(client, clock)| *clock <= seen.get(client))
}

/// Runs inside the tombstone's transaction, before the row, its projection
/// and its body log are deleted. Keeps nothing for a type other than `note`
/// or `journal`, a row already deleted, a foreign journal id (the day merge
/// holds those, #2984) or a blank body.
#[allow(clippy::too_many_arguments)]
pub(crate) fn keep(
    tx: &Connection,
    item_type: &str,
    item_id: &str,
    deleted_at: i64,
    server_cursor: Option<i64>,
    tombstone: Option<&VectorClock>,
    deleter_body_state_vector: Option<&str>,
    clock_device: Option<&str>,
    vault_root: Option<&Path>,
    now_ms: i64,
) -> Result<(), StorageError> {
    let Some(title) = copy_title(tx, item_type, item_id)? else {
        return Ok(());
    };
    let Some(row) = sync_items::load(tx, item_type, item_id)? else {
        return Ok(());
    };
    if row.deleted_at.is_some() {
        return Ok(());
    }
    let mut facts = UnseenTextFacts {
        waiting_changes: tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM outbox WHERE item_type = ?1 AND item_id = ?2)",
                params![item_type, item_id],
                |r| r.get(0),
            )
            .map_err(failed)?,
        local_clock: row.clock.and_then(|text| serde_json::from_str(&text).ok()),
        tombstone_clock: tombstone.cloned(),
        deleted_at: Some(deleted_at),
        // A local fold keeps the newest stamp of the rows it took
        // (`crdt::compact`), so the snapshot's stamp counts as an edit's.
        last_local_body_at: tx
            .query_row(
                "SELECT MAX(at) FROM (
                   SELECT MAX(created_at) AS at FROM yjs_updates WHERE doc_id = ?1
                   UNION ALL
                   SELECT compacted_at FROM yjs_snapshots WHERE doc_id = ?1
                 )",
                params![format!("{LOCAL_NAMESPACE_PREFIX}{item_id}")],
                |r| r.get(0),
            )
            .map_err(failed)?,
        body_blank: false,
        deleter_body_state_vector: deleter_body_state_vector.map(str::to_owned),
        local_body_state_vector: None,
    };
    // A body log with a blob that does not replay never fails the delete
    // (#5343). Its text is read where Electron reads every body, the vault
    // file (`apps/desktop/src/main/sync/keep-unseen-text.ts:46-52`,
    // `item-handlers/note-handler.ts:750-760`), and from the blobs that did
    // replay when there is no file to read, so readable text is never lost.
    let plan = update_log::load_plan(tx, item_id).map_err(crdt_failed(item_id))?;
    let (document, skipped) =
        replay_readable(&plan, item_id, server_cursor).map_err(crdt_failed(item_id))?;
    match document.state_vector() {
        Ok(state_vector) => facts.local_body_state_vector = Some(BASE64.encode(state_vector)),
        Err(error) => eprintln!("memry-core: no state vector for the body of {item_id}: {error}"),
    }
    // Invariant: a file this device has not ingested is never deleted unseen. A note's or
    // journal day's file edited outside the app that the document has not taken yet (a
    // closed-app edit the open walk has not reached, one still in the watcher's debounce) holds
    // text no clock or body log here knows of: it is unseen whatever the clocks say, and the
    // copy keeps the file's text (#5758, #5796, desktop's #5757).
    let unseen_file = untaken_file_body(tx, vault_root, item_id)?;
    let forced = unseen_file.is_some();
    if !forced && !keeps_unseen_text(&facts) {
        return Ok(());
    }
    let file = match unseen_file {
        Some(text) => Some(text),
        None if skipped > 0 => vault_file_body(tx, vault_root, item_id)?,
        None => None,
    };
    let text = match file {
        Some(text) => text,
        None => match extract_text(&document) {
            Ok(text) => text,
            Err(error) => {
                eprintln!("memry-core: the body of {item_id} has no text to keep: {error}");
                return Ok(());
            }
        },
    };
    facts.body_blank = text.trim().is_empty();
    if facts.body_blank || (!forced && !keeps_unseen_text(&facts)) {
        return Ok(());
    }
    let device = clock_device.ok_or_else(|| StorageError::Failed {
        what: "keeping unseen text needs this device's clock id (chapter 01 §1.5)".to_owned(),
    })?;
    capture_in(
        tx,
        &NewCapture {
            item_type: "note".to_owned(),
            title,
            content: Some(text),
            processing_status: "complete".to_owned(),
            ..NewCapture::default()
        },
        device,
        now_ms,
    )?;
    Ok(())
}

/// The copy's title, or `None` when nothing may be kept for this item.
fn copy_title(
    tx: &Connection,
    item_type: &str,
    item_id: &str,
) -> Result<Option<String>, StorageError> {
    if item_type == journal::ITEM_TYPE {
        let date: Option<String> = tx
            .query_row(
                "SELECT date FROM journal_entries WHERE id = ?1",
                params![item_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(failed)?;
        return Ok(date
            .filter(|date| canonical_journal_id(date) == item_id)
            .map(|date| format!("Journal {date} (kept from deleted day)")));
    }
    if item_type != "note" {
        return Ok(None);
    }
    let title: Option<String> = tx
        .query_row(
            "SELECT title FROM notes WHERE id = ?1 AND file_type = 'markdown'",
            params![item_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(failed)?;
    Ok(title.map(|title| {
        let title = if title.is_empty() { "Untitled" } else { &title };
        format!("{title} (kept from deleted note)")
    }))
}

/// The body of `item_id`'s vault file without its frontmatter, `None` when
/// there is no file to read: Electron's `readNoteFileBody`
/// (`keep-unseen-text.ts:46-52`). A shell with no vault files (iOS) has none.
fn vault_file_body(
    tx: &Connection,
    vault_root: Option<&Path>,
    item_id: &str,
) -> Result<Option<String>, StorageError> {
    let Some(root) = vault_root else {
        return Ok(None);
    };
    let Some(row) = note_files::by_id(tx, item_id)? else {
        eprintln!(
            "memry-core: {item_id} has no vault file, its delete keeps the text that replays"
        );
        return Ok(None);
    };
    match std::fs::read_to_string(root.join(&row.path)) {
        Ok(raw) => Ok(Some(file_body(&raw))),
        Err(error) => {
            eprintln!(
                "memry-core: the vault file of {item_id} cannot be read, its delete keeps \
                 the text that replays: {error}"
            );
            Ok(None)
        }
    }
}

/// The body of `item_id`'s vault file when its bytes are not the ones the document took
/// (the row's `content_hash`), `None` when they are, when the row names no text the document
/// took, or when there is no file to read.
fn untaken_file_body(
    tx: &Connection,
    vault_root: Option<&Path>,
    item_id: &str,
) -> Result<Option<String>, StorageError> {
    let Some(root) = vault_root else {
        return Ok(None);
    };
    let Some(row) = note_files::by_id(tx, item_id)? else {
        return Ok(None);
    };
    let Some(taken) = row.content_hash else {
        return Ok(None);
    };
    let raw = match std::fs::read(root.join(&row.path)) {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            eprintln!(
                "memry-core: the vault file of {item_id} cannot be read before its delete: {error}"
            );
            return Ok(None);
        }
    };
    Ok((content_hash(&raw) != taken).then(|| file_body(&raw)))
}

#[cfg(feature = "markdown")]
fn file_body(raw: &str) -> String {
    crate::markdown::frontmatter::split_frontmatter_block(raw)
        .body
        .to_owned()
}

/// Only desktop (`markdown`) reads vault files.
#[cfg(not(feature = "markdown"))]
fn file_body(raw: &str) -> String {
    raw.to_owned()
}

/// Base64 Yjs v1 state vector of `doc_id`'s whole body log: the
/// `bodyStateVector` a note or journal delete carries (§5.8, #3037).
pub(crate) fn body_state_vector(tx: &Connection, doc_id: &str) -> Result<String, StorageError> {
    let document = open_body(tx, doc_id)?;
    Ok(BASE64.encode(document.state_vector().map_err(crdt_failed(doc_id))?))
}

fn open_body(tx: &Connection, doc_id: &str) -> Result<Arc<Document>, StorageError> {
    let plan = update_log::load_plan(tx, doc_id).map_err(crdt_failed(doc_id))?;
    replay(&plan, doc_id).map_err(crdt_failed(doc_id))
}

fn replay(plan: &update_log::LoadPlan, doc_id: &str) -> Result<Arc<Document>, CrdtError> {
    let sink: UpdateSink = Arc::new(|_, _| {});
    let document = DocumentRegistry::new(READER_DEVICE_ID, sink).get_or_open(doc_id)?;
    for blob in plan.blobs() {
        document.apply_durable_update(blob)?;
    }
    Ok(document)
}

/// Replays every blob of `plan` that applies and counts the ones that do not,
/// logging each with the delete's cursor.
fn replay_readable(
    plan: &update_log::LoadPlan,
    doc_id: &str,
    server_cursor: Option<i64>,
) -> Result<(Arc<Document>, usize), CrdtError> {
    let sink: UpdateSink = Arc::new(|_, _| {});
    let document = DocumentRegistry::new(READER_DEVICE_ID, sink).get_or_open(doc_id)?;
    let mut skipped = 0;
    for (index, blob) in plan.blobs().into_iter().enumerate() {
        if let Err(error) = document.apply_durable_update(blob) {
            eprintln!(
                "memry-core: blob {index} of the body of {doc_id} (cursor {server_cursor:?}) \
                 does not replay before its delete: {error}"
            );
            skipped += 1;
        }
    }
    Ok((document, skipped))
}

fn crdt_failed<E: std::fmt::Display>(doc_id: &str) -> impl Fn(E) -> StorageError + '_ {
    move |error| StorageError::Failed {
        what: format!("read the body of {doc_id} before its delete: {error}"),
    }
}

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}
