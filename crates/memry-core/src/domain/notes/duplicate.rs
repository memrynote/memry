//! Duplicate a note: a new note beside the original, with its icon, cover,
//! tags, properties and body.
//!
//! **What is not copied.** `aliases`, because two notes declaring one alias
//! make that wiki link ambiguous; `attachmentReferences`, because a reference
//! is the note that uploaded the bytes (§14.7) and the copy uploaded nothing.
//! The copy's body still shows the original's attachments: a block names an
//! attachment by its vault path, which the copy reads like any other note.
//!
//! **One transaction.** The record, its outbox row, the body update and its
//! outbox row commit together (FR-030), with the record queued first so a
//! peer never receives a body for a note it does not hold yet.

use std::sync::Arc;

use rusqlite::Connection;
use serde_json::{Value, json};

use crate::crdt::body_edit;
use crate::crdt::errors::CrdtError;
use crate::crdt::registry::UpdateSink;
use crate::crdt::{DocumentRegistry, update_log};
use crate::domain::body_write;
use crate::domain::reads;
use crate::storage::repositories::schema::Object;
use crate::sync::outbox;

use super::{
    ITEM_TYPE, failed, insert_local, iso, next_clock, object, require_payload, seed_body,
    valid_document_id,
};

/// The payload keys a copy carries over as they are stored.
const COPIED_KEYS: &[&str] = &[
    "folderPath",
    "emoji",
    "cover",
    "coverImage",
    "tags",
    "properties",
];

/// Copies `source_id` into a new note `new_id` titled `title`.
///
/// - Returns: `false` when this vault holds no live note `source_id`.
pub fn duplicate(
    conn: &Connection,
    source_id: &str,
    new_id: &str,
    title: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<bool, CrdtError> {
    if !reads::note_exists(conn, source_id) {
        return Ok(false);
    }
    valid_document_id(new_id)?;
    let snapshots = body_snapshots(conn, source_id, device_id)?;
    let update = body_write::author_appends(conn, new_id, &snapshots, device_id)?;

    let tx = conn
        .unchecked_transaction()
        .map_err(|error| CrdtError::from(failed(error)))?;
    let stored = require_payload(&tx, ITEM_TYPE, source_id)?;
    let at = iso(now_ms)?;
    let mut payload = object(json!({
        "title": title,
        "content": "",
        "fileType": "markdown",
        "folderPath": Value::Null,
        "clock": next_clock(&Object::new(), device_id)?,
        "createdAt": at,
        "modifiedAt": at,
    }));
    for key in COPIED_KEYS {
        if let Some(value) = stored.object().get(*key) {
            payload.insert((*key).to_owned(), value.clone());
        }
    }
    insert_local(&tx, ITEM_TYPE, new_id, payload, now_ms)?;
    seed_body(&tx, new_id, "", now_ms)?;
    outbox::enqueue(&tx, &outbox::Change::upsert(ITEM_TYPE, new_id), now_ms)?;
    if let Some(update) = update {
        body_write::append_in(&tx, ITEM_TYPE, new_id, &update, now_ms)?;
    }
    tx.commit()
        .map_err(|error| CrdtError::from(failed(error)))?;
    Ok(true)
}

/// Every top-level block of `note_id`'s body, as snapshots, in order.
fn body_snapshots(
    conn: &Connection,
    note_id: &str,
    device_id: &str,
) -> Result<Vec<String>, CrdtError> {
    let sink: UpdateSink = Arc::new(|_, _| {});
    let document = DocumentRegistry::new(device_id, sink).get_or_open(note_id)?;
    for blob in update_log::load_plan(conn, note_id)?.blobs() {
        document.apply_durable_update(blob)?;
    }
    body_edit::top_level_block_ids(&document)?
        .iter()
        .map(|id| body_edit::snapshot_block(&document, id))
        .collect()
}
