//! A journal day's picture references across devices (#5800, chapter 14
//! §14.7.2).
//!
//! A journal payload has no `attachmentReferences` (§13.7.2), so a day names
//! its pictures to peers in a `note` record under the day's own id,
//! `j<YYYY-MM-DD>`. Every device that adds or removes a picture pushes the
//! whole list under one document clock, and the server keeps one record per id
//! and takes a concurrent write as it comes. Two devices that add a picture to
//! one day at once leave the server with one of the two lists, and a device
//! that bootstraps later never fetches the other picture.
//!
//! The rule, per id, against the clock this device first held the id at or
//! last removed it at (`day_picture_ref_clocks`, migration 0019):
//!
//! - A record whose clock dominates is adopted as is. An id it lacks was
//!   removed by a device that saw it, so the removal stands.
//! - A concurrent record is merged id by id. An id this device holds and the
//!   record lacks is dropped when the sender's clock dominates the clock this
//!   device held it at (the sender saw it, then removed it), and kept
//!   otherwise. An id the record holds is taken, unless this device removed it
//!   at a clock the sender's does not dominate.
//! - The merge is pushed again only when it keeps an id, or a removal, that the
//!   sender could not have seen. A kept id counts only when this device holds
//!   its manifest: an id it cannot resolve stays in the stored list but is
//!   never a reason to push, so no two devices bounce a list over it. The
//!   device that uploaded a picture always holds its manifest, so it is the
//!   one that pushes it back.
//!
//! Desktop applies the same record last-write-wins (#5785). It adopts a pushed
//! merge, whose clock dominates what it sent, so it converges with this rule.

use std::collections::HashMap;

use rusqlite::{Connection, params};
use serde_json::{Value, json};

use crate::api::errors::StorageError;
use crate::domain::task_merge::{self, Gate};
use crate::domain::tasks::Inbound;
use crate::domain::{attachments, journal, notes};
use crate::storage::nested_tx;
use crate::storage::repositories::schema::Object;
use crate::storage::repositories::sync_items::InboundRecord;
use crate::storage::repositories::{Change, StoredPayload};
use crate::sync::clock::{self, ClockOrder, VectorClock};
use crate::sync::outbox;

const REFERENCES: &str = "attachmentReferences";

/// Whether `item_id` is a day's canonical id, `j<YYYY-MM-DD>`.
pub(crate) fn is_day_note(item_id: &str) -> bool {
    item_id
        .strip_prefix('j')
        .is_some_and(|date| journal::valid_date(date).is_ok())
}

/// Creates the day's `note` record for its first picture, in the shape desktop
/// pushes (`recordOnNote`): the day's title and folder, and the references.
/// No `content`: the body is the journal's document. The caller queues the
/// upsert in the same transaction.
pub(crate) fn create_day_note(
    tx: &Connection,
    note_id: &str,
    references: &[String],
    device_id: &str,
    now_ms: i64,
) -> Result<String, StorageError> {
    let at = notes::iso(now_ms)?;
    let payload = notes::object(json!({
        "title": &note_id[1..],
        "fileType": "markdown",
        "folderPath": "journal",
        "attachmentReferences": references,
        "clock": notes::next_clock(&Object::new(), device_id)?,
        "createdAt": at,
        "modifiedAt": at,
    }));
    let stored = notes::insert_local(tx, notes::ITEM_TYPE, note_id, payload, now_ms)?;
    note_local_edit(tx, note_id, &[], &stored)?;
    Ok(stored)
}

/// Records a local edit of a day's list: `stored` is the payload now in the
/// row, whose clock is the one this device holds its ids at.
pub(crate) fn note_local_edit(
    tx: &Connection,
    note_id: &str,
    before: &[String],
    stored: &str,
) -> Result<(), StorageError> {
    if !is_day_note(note_id) {
        return Ok(());
    }
    let payload = StoredPayload::parse(stored).map_err(|error| StorageError::Failed {
        what: format!("note {note_id} will not read back: {error}"),
    })?;
    let after = references(payload.object()).unwrap_or_default();
    let at = notes::clock_in(payload.object())?;
    hold(tx, note_id, &after, &at)?;
    remove(tx, note_id, &missing(before, &after), &at)
}

/// §6.3.1's document gate for a day's `note` record, with the list merged id
/// by id on the concurrent branch (module docs). One transaction, so a merge
/// and the push it owes commit together.
pub(crate) fn apply_remote(
    conn: &Connection,
    record: &InboundRecord,
    now_ms: i64,
    clock_device: Option<&str>,
) -> Result<Inbound, StorageError> {
    let tx = nested_tx::begin(conn).map_err(notes::failed)?;
    let before = notes::read_attachment_references(&tx, &record.item_id)?;
    let inbound = match task_merge::document_gate(&tx, record)? {
        Gate::Skip => Inbound::Skipped,
        Gate::Wholesale => {
            let inbound = task_merge::wholesale(&tx, record, now_ms)?;
            let remote = StoredPayload::parse(&record.payload_json).ok();
            if matches!(inbound, Inbound::Applied)
                && record.deleted_at.is_none()
                && let Some(remote) = remote
                && let Some(after) = references(remote.object())
            {
                let sender = notes::clock_in(remote.object())?;
                hold(&tx, &record.item_id, &after, &sender)?;
                remove(&tx, &record.item_id, &missing(&before, &after), &sender)?;
            }
            inbound
        }
        Gate::Merge {
            local,
            remote,
            merged_clock,
        } => merge(
            &tx,
            record,
            local.object(),
            &remote,
            merged_clock,
            clock_device,
            now_ms,
        )?,
    };
    tx.commit().map_err(notes::failed)?;
    Ok(inbound)
}

/// The concurrent branch: the remote's payload under the merged clock, with
/// the merged list, and the upsert when the sender has something to learn.
fn merge(
    tx: &Connection,
    record: &InboundRecord,
    local: &Object,
    remote: &StoredPayload,
    merged_clock: VectorClock,
    clock_device: Option<&str>,
    now_ms: i64,
) -> Result<Inbound, StorageError> {
    let note_id = &record.item_id;
    let sender = notes::clock_in(remote.object())?;
    let (local_refs, remote_refs) = (references(local), references(remote.object()));
    let merged = match (&local_refs, &remote_refs) {
        (Some(local_refs), Some(remote_refs)) => {
            let marks = marks(tx, note_id)?;
            merge_lists(local_refs, remote_refs, &sender, &marks, |id| {
                Ok(attachments::get(tx, id)?.is_some_and(|row| row.manifest.is_some()))
            })?
        }
        // §14.7: an absent list is "this sender does not know", so the list
        // that is known stands and nothing is owed.
        _ => Merged {
            references: remote_refs.clone().or(local_refs.clone()),
            push: false,
        },
    };
    // A tick of this device's own makes the push a write no peer holds, so
    // two devices pushing the same merge are not refused as replays.
    let stored_clock = match clock_device.filter(|_| merged.push) {
        Some(device) => clock::increment(&merged_clock, device),
        None => merged_clock,
    };
    let mut changes = vec![(
        "clock",
        Change::Set(
            serde_json::to_value(&stored_clock).map_err(|error| StorageError::Failed {
                what: format!("clock will not serialise: {error}"),
            })?,
        ),
    )];
    if let Some(list) = &merged.references {
        changes.push((REFERENCES, Change::Set(json!(list))));
    }
    let merged_record = InboundRecord {
        payload_json: remote.merge(&changes),
        ..record.clone()
    };
    let inbound = task_merge::wholesale(tx, &merged_record, now_ms)?;
    if !matches!(inbound, Inbound::Applied) {
        return Ok(inbound);
    }
    if let (Some(list), Some(local_refs)) = (&merged.references, &local_refs) {
        let from_sender: Vec<String> = remote_refs
            .iter()
            .flatten()
            .filter(|id| list.contains(id))
            .cloned()
            .collect();
        hold(tx, note_id, &from_sender, &sender)?;
        hold(tx, note_id, list, &stored_clock)?;
        remove(tx, note_id, &missing(local_refs, list), &sender)?;
    }
    if merged.push {
        outbox::enqueue(
            tx,
            &outbox::Change::upsert(notes::ITEM_TYPE, note_id),
            now_ms,
        )?;
    }
    Ok(inbound)
}

/// What a concurrent merge of two lists comes to.
#[derive(Debug, PartialEq, Eq)]
struct Merged {
    references: Option<Vec<String>>,
    /// The sender could not have seen something the merge keeps.
    push: bool,
}

/// Per id: `true` with the clock this device first held it at, or `false`
/// with the clock it last removed it at.
type Marks = HashMap<String, (bool, VectorClock)>;

/// The module docs' rule over two known lists. Order: the sender's, then the
/// ids only this device holds.
fn merge_lists(
    local: &[String],
    remote: &[String],
    sender: &VectorClock,
    marks: &Marks,
    resolvable: impl Fn(&str) -> Result<bool, StorageError>,
) -> Result<Merged, StorageError> {
    let saw = |at: &VectorClock| {
        matches!(
            clock::compare(sender, at),
            ClockOrder::After | ClockOrder::Equal
        )
    };
    let mut references = Vec::new();
    let mut push = false;
    for id in remote {
        let removed_unseen =
            !local.contains(id) && matches!(marks.get(id), Some((false, at)) if !saw(at));
        if removed_unseen {
            push = true;
        } else {
            references.push(id.clone());
        }
    }
    for id in missing(local, remote) {
        if matches!(marks.get(&id), Some((true, at)) if saw(at)) {
            continue;
        }
        push |= resolvable(&id)?;
        references.push(id);
    }
    Ok(Merged {
        references: Some(references),
        push,
    })
}

/// A payload's list, or `None` when the sender does not know (§14.7).
fn references(payload: &Object) -> Option<Vec<String>> {
    payload.get(REFERENCES)?.as_array().map(|list| {
        list.iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect()
    })
}

/// The ids of `from` that `to` lacks.
fn missing(from: &[String], to: &[String]) -> Vec<String> {
    from.iter().filter(|id| !to.contains(id)).cloned().collect()
}

fn marks(conn: &Connection, note_id: &str) -> Result<Marks, StorageError> {
    let rows: Vec<(String, bool, String)> = conn
        .prepare_cached(
            "SELECT attachment_id, held, clock FROM day_picture_ref_clocks WHERE note_id = ?1",
        )
        .and_then(|mut statement| {
            statement
                .query_map([note_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
                .collect()
        })
        .map_err(notes::failed)?;
    let mut marks = Marks::new();
    for (id, held, text) in rows {
        match serde_json::from_str::<VectorClock>(&text) {
            Ok(at) => {
                marks.insert(id, (held, at));
            }
            // Read as no knowledge, which keeps the picture.
            Err(error) => eprintln!(
                "memry-core: day pictures: {note_id} mark for {id} is not a clock ({error}); \
                 the picture is kept"
            ),
        }
    }
    Ok(marks)
}

/// Marks `ids` held at `at`, keeping an earlier held mark: the first clock an
/// id was held at is the one any later sender must dominate to have seen it.
fn hold(
    conn: &Connection,
    note_id: &str,
    ids: &[String],
    at: &VectorClock,
) -> Result<(), StorageError> {
    write_marks(
        conn,
        "INSERT INTO day_picture_ref_clocks (note_id, attachment_id, held, clock)
         VALUES (?1, ?2, 1, ?3)
         ON CONFLICT(note_id, attachment_id) DO UPDATE SET held = 1, clock = excluded.clock
         WHERE held = 0",
        note_id,
        ids,
        at,
    )
}

/// Marks `ids` removed at `at`.
fn remove(
    conn: &Connection,
    note_id: &str,
    ids: &[String],
    at: &VectorClock,
) -> Result<(), StorageError> {
    write_marks(
        conn,
        "INSERT INTO day_picture_ref_clocks (note_id, attachment_id, held, clock)
         VALUES (?1, ?2, 0, ?3)
         ON CONFLICT(note_id, attachment_id) DO UPDATE SET held = 0, clock = excluded.clock",
        note_id,
        ids,
        at,
    )
}

fn write_marks(
    conn: &Connection,
    sql: &str,
    note_id: &str,
    ids: &[String],
    at: &VectorClock,
) -> Result<(), StorageError> {
    if ids.is_empty() {
        return Ok(());
    }
    let at = serde_json::to_string(at).map_err(|error| StorageError::Failed {
        what: format!("clock will not serialise: {error}"),
    })?;
    let mut statement = conn.prepare_cached(sql).map_err(notes::failed)?;
    for id in ids {
        statement
            .execute(params![note_id, id, at])
            .map_err(notes::failed)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests;
