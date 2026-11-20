//! What [`super::apply_page_into`] tells the observers about each record
//! ([`crate::sync::driver::observer`]): its outcome, the fields a concurrent
//! merge decided, a note revived by a losing tombstone, and the attachments an
//! applied note references.

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value as Json;

use crate::api::errors::StorageError;
use crate::domain::notes;
use crate::storage::repositories::sync_items::{self, ApplyOutcome, InboundRecord};
use crate::sync::clock::VectorClock;
use crate::sync::driver::observer::{
    AppliedFeed, AppliedOutcome, AppliedRecord, AttachmentDownload, FieldConflict,
};
use crate::sync::field_merge;

use super::sqlite_failed;

/// Whether a live local row with a payload exists, which is what tells an
/// update from a create. A metadata-only row (first sync's refs pass) has none.
pub(super) fn is_live(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
) -> Result<bool, StorageError> {
    conn.query_row(
        "SELECT 1 FROM sync_items WHERE item_type = ?1 AND item_id = ?2
           AND deleted_at IS NULL AND payload IS NOT NULL",
        params![item_type, item_id],
        |_| Ok(()),
    )
    .optional()
    .map(|found| found.is_some())
    .map_err(sqlite_failed)
}

/// Adds one pulled record. `merged` is the conflict set of a concurrent
/// merge, `None` for any other apply.
pub(super) fn record(
    conn: &Connection,
    feed: &mut AppliedFeed,
    record: &InboundRecord,
    outcome: &ApplyOutcome,
    existed: bool,
    merged: Option<Vec<field_merge::FieldConflict>>,
) -> Result<(), StorageError> {
    let (outcome, conflicts) = match (outcome, merged) {
        (ApplyOutcome::Applied, Some(conflicts)) => (
            AppliedOutcome::Merged,
            conflicts.into_iter().map(conflict).collect(),
        ),
        (ApplyOutcome::Applied, None) if existed => (AppliedOutcome::Updated, Vec::new()),
        (ApplyOutcome::Applied, None) => (AppliedOutcome::Created, Vec::new()),
        // Nothing local changed: the local row won, the schema refused it, it
        // is stored flagged (§13.2 rule 5), or it expired (§13.12).
        _ => (AppliedOutcome::Skipped, Vec::new()),
    };
    // The record first: the row is committed, so a failure below must not
    // drop its outcome.
    feed.records.push(AppliedRecord {
        item_type: record.item_type.clone(),
        item_id: record.item_id.clone(),
        outcome,
        conflicts,
    });
    // Electron asks again on an identical skip too: the only re-request for a
    // download that died with the process before the page re-pulled (#2294).
    if record.item_type == notes::ITEM_TYPE
        && (outcome != AppliedOutcome::Skipped || identical_skip(conn, record)?)
    {
        feed.downloads
            .extend(downloads(record, outcome == AppliedOutcome::Created));
    }
    Ok(())
}

/// Adds one record a tombstone deleted. A tombstone for an item that was
/// never live here, or is already deleted, changed nothing and is `Skipped`
/// (Electron's `note-handler.ts:739`).
pub(super) fn deleted(feed: &mut AppliedFeed, item_type: &str, item_id: &str, was_live: bool) {
    let outcome = if was_live {
        AppliedOutcome::Deleted
    } else {
        AppliedOutcome::Skipped
    };
    push(feed, item_type, item_id, outcome);
}

/// Adds one tombstone that lost to a newer local edit. A note lives on, so it
/// is revived (Electron's `note-handler.ts:744`).
pub(super) fn revived(feed: &mut AppliedFeed, item_type: &str, item_id: &str) {
    if item_type == notes::ITEM_TYPE {
        feed.revived_notes.push(item_id.to_owned());
    }
    push(feed, item_type, item_id, AppliedOutcome::Skipped);
}

fn push(feed: &mut AppliedFeed, item_type: &str, item_id: &str, outcome: AppliedOutcome) {
    feed.records.push(AppliedRecord {
        item_type: item_type.to_owned(),
        item_id: item_id.to_owned(),
        outcome,
        conflicts: Vec::new(),
    });
}

/// The winner and the loser of one decided field. A value the side did not
/// send is `null`.
fn conflict(decided: field_merge::FieldConflict) -> FieldConflict {
    // Absent is not `null` here (Electron compares `JSON.stringify` of each).
    let local_lost = decided.local_value != decided.merged_value;
    let winning = decided.merged_value.unwrap_or(Json::Null);
    let losing = if local_lost {
        decided.local_value.unwrap_or(Json::Null)
    } else {
        decided.remote_value.unwrap_or(Json::Null)
    };
    FieldConflict {
        field: decided.field,
        losing,
        winning,
        merged_clock: serde_json::to_value(&decided.merged_clock).unwrap_or(Json::Null),
        local_lost,
    }
}

/// Whether the stored row carries the remote's clock, so the skip was §6.5.2
/// P4's identical record rather than a newer local edit.
fn identical_skip(conn: &Connection, record: &InboundRecord) -> Result<bool, StorageError> {
    let Some(stored) = sync_items::load(conn, &record.item_type, &record.item_id)?
        .and_then(|row| row.clock)
        .and_then(|clock| serde_json::from_str::<VectorClock>(&clock).ok())
    else {
        return Ok(false);
    };
    let remote = serde_json::from_str::<Json>(&record.payload_json)
        .ok()
        .and_then(|payload| payload.get("clock").cloned())
        .and_then(|clock| serde_json::from_value::<VectorClock>(clock).ok());
    Ok(remote.is_some_and(|remote| remote == stored))
}

/// The attachments a note references and, when `created` and the note is not
/// markdown, its own file (Electron's `note-handler.ts:637-644`).
fn downloads(record: &InboundRecord, created: bool) -> Vec<AttachmentDownload> {
    let Ok(payload) = serde_json::from_str::<Json>(&record.payload_json) else {
        return Vec::new();
    };
    let own_file = payload
        .get("fileType")
        .and_then(Json::as_str)
        .filter(|file_type| created && *file_type != "markdown")
        .and(payload.get("attachmentId").and_then(Json::as_str))
        .map(|attachment_id| AttachmentDownload {
            owner_id: record.item_id.clone(),
            attachment_id: attachment_id.to_owned(),
            hint: record.item_type.clone(),
            own_file: true,
        });
    let references = payload
        .get("attachmentReferences")
        .and_then(Json::as_array)
        .into_iter()
        .flatten()
        .filter_map(Json::as_str)
        .map(|attachment_id| AttachmentDownload {
            owner_id: record.item_id.clone(),
            attachment_id: attachment_id.to_owned(),
            hint: record.item_type.clone(),
            own_file: false,
        });
    own_file.into_iter().chain(references).collect()
}
