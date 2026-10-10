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
//!    the delete is applied, unless it was pushed in an earlier pass.
//!
//! The core never writes markdown, so the copy holds [`extract_text`]'s plain
//! text: words, headings and list markers, without inline formatting.

use std::sync::Arc;

use rusqlite::{Connection, OptionalExtension as _, params};

use crate::api::errors::StorageError;
use crate::crdt::registry::{DocumentRegistry, UpdateSink};
use crate::crdt::text_extract::extract_text;
use crate::crdt::update_log::{self, LOCAL_NAMESPACE_PREFIX};
use crate::domain::inbox::write::{NewCapture, capture_in};
use crate::domain::journal;
use crate::domain::journal_rules::canonical_journal_id;
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
    match (facts.deleted_at, facts.last_local_body_at) {
        (Some(deleted_at), Some(last)) => last >= deleted_at_ms(deleted_at) - DELETE_KEEP_SKEW_MS,
        _ => false,
    }
}

/// Runs inside the tombstone's transaction, before the row, its projection
/// and its body log are deleted. Keeps nothing for a type other than `note`
/// or `journal`, a row already deleted, a foreign journal id (the day merge
/// holds those, #2984) or a blank body.
pub(crate) fn keep(
    tx: &Connection,
    item_type: &str,
    item_id: &str,
    deleted_at: i64,
    tombstone: Option<&VectorClock>,
    clock_device: Option<&str>,
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
        last_local_body_at: tx
            .query_row(
                "SELECT MAX(created_at) FROM yjs_updates WHERE doc_id = ?1",
                params![format!("{LOCAL_NAMESPACE_PREFIX}{item_id}")],
                |r| r.get(0),
            )
            .map_err(failed)?,
        body_blank: false,
    };
    if !keeps_unseen_text(&facts) {
        return Ok(());
    }
    let text = body_text(tx, item_id)?;
    facts.body_blank = text.trim().is_empty();
    if !keeps_unseen_text(&facts) {
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

fn body_text(tx: &Connection, doc_id: &str) -> Result<String, StorageError> {
    let crdt = |error| StorageError::Failed {
        what: format!("read the body of {doc_id} before its delete: {error}"),
    };
    let plan = update_log::load_plan(tx, doc_id).map_err(crdt)?;
    let sink: UpdateSink = Arc::new(|_, _| {});
    let document = DocumentRegistry::new(READER_DEVICE_ID, sink)
        .get_or_open(doc_id)
        .map_err(crdt)?;
    for blob in plan.blobs() {
        document.apply_durable_update(blob).map_err(crdt)?;
    }
    extract_text(&document).map_err(crdt)
}

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}
