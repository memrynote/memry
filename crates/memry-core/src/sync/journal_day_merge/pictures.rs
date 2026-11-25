//! A merged day's pictures (§1.9.1 step 6, chapter 14 §14.7, #5777).
//!
//! A day's pictures are fetchable wherever the day is. A journal payload has
//! no `attachmentReferences` (§13.7.2), so a day names its pictures to peers
//! in a `note` record under its own id, as desktop's upload to the day does
//! (`recordOnNote`, #5731). A foreign id `F` named its pictures in a `note`
//! record under `F`. Folding `F`'s body into `j<D>` without its references
//! leaves a device that never held `F` with a day whose embedded pictures it
//! cannot fetch. The server keeps each attachment by its own id, not by note
//! (§14.7), so the bytes `F` uploaded need no second upload once `j<D>` names
//! them.
//!
//! Desktop pairs a lone reference with a lone unrecorded file in `F`'s folder
//! (#5782). The core has no such folder: it stores every file under its
//! attachment id (`images/<id>`), so a carried reference already finds its
//! bytes and nothing is paired.

use rusqlite::Connection;
use serde_json::json;

use crate::api::errors::StorageError;
use crate::domain::{attachment_refs, notes};
use crate::storage::repositories::schema::Object;
use crate::storage::repositories::sync_items;
use crate::sync::outbox;

/// Unions `F`'s references into `j<D>`'s and queues `j<D>`'s `note` record,
/// creating it in desktop's shape when the day has none. Runs in the settle's
/// transaction, so a crash leaves neither half. Queues nothing when `j<D>`
/// names every reference already, so a re-run or a peer's echo pushes nothing.
pub(super) fn carry(
    tx: &Connection,
    foreign: &str,
    canonical: &str,
    date: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    let carried = notes::read_attachment_references(tx, foreign)?;
    if carried.is_empty() {
        return Ok(());
    }
    match sync_items::load(tx, notes::ITEM_TYPE, canonical)? {
        None => create_day_note(tx, canonical, date, &carried, device_id, now_ms),
        Some(row) if row.deleted_at.is_none() && row.payload.is_some() => {
            notes::add_attachment_references(tx, canonical, &carried, device_id, now_ms)?;
            Ok(())
        }
        // A tombstoned or bodiless day record cannot take an edit here. The
        // references stay on `F`'s own note row, which the merge leaves.
        Some(_) => {
            eprintln!(
                "memry-core: journal day merge of {foreign} cannot name {} attachment(s) under \
                 {canonical}: its note record is deleted or not pulled",
                carried.len()
            );
            Ok(())
        }
    }
}

/// The `note` record desktop pushes under a day's id (`recordOnNote`): the
/// day's title and folder, and its references. No `content`: the body is the
/// journal's doc.
fn create_day_note(
    tx: &Connection,
    canonical: &str,
    date: &str,
    references: &[String],
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    let at = notes::iso(now_ms)?;
    let payload = notes::object(json!({
        "title": date,
        "fileType": "markdown",
        "folderPath": "journal",
        "attachmentReferences": references,
        "clock": notes::next_clock(&Object::new(), device_id)?,
        "createdAt": at,
        "modifiedAt": at,
    }));
    // Before the row takes the list: the stored list bounds what it drops.
    attachment_refs::merge_note_references(tx, canonical, Some(references))?;
    notes::insert_local(tx, notes::ITEM_TYPE, canonical, payload, now_ms)?;
    outbox::enqueue(
        tx,
        &outbox::Change::upsert(notes::ITEM_TYPE, canonical),
        now_ms,
    )?;
    Ok(())
}
