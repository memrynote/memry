//! A journal day's picture references across devices (#5800, chapter 14
//! §14.7.4).
//!
//! A journal payload has no `attachmentReferences` (§13.7.2), so a day names
//! its pictures to peers in a `note` record under the day's own id,
//! `j<YYYY-MM-DD>`. The server keeps one record per id and takes a concurrent
//! write as it comes, so two devices that add a picture to one day at once
//! leave it with one of the two lists.
//!
//! **Invariant: a picture leaves a day only through a removal a device made on
//! purpose, and a removal is never undone by a peer's list.** A list's silence
//! about an id is never read as a removal, because no sender's silence can be
//! trusted:
//!
//! - Electron desktop pushes the record under the journal row's clock and
//!   never adopts the record's own (note-handler.ts, `buildNotePushPayload`),
//!   so its clock can dominate a list it never saw. It unions an inbound list
//!   into its own, so its list keeps an id a core device removed.
//! - Core devices that adopted such a record before this rule carry those
//!   clocks too, so a core clock that dominates proves nothing about the list
//!   either.
//!
//! So the record carries its removals: `removedAttachmentReferences`, the ids a
//! core device removed, which desktop strips on parse and never sends. An
//! inbound record joins the stored one: live is the union of both lists minus
//! the union of both removals. The join needs no clock, no signer and no local
//! table, and it reads the same for a record from desktop, from an older core
//! build, or from a vault that predates the rule: an id the core holds stays,
//! and an id it removed stays removed. A desktop removal does not reach core
//! devices (desktop sends none), and an id stays removed for good: ids are
//! minted per upload, so a re-add is a new id.
//!
//! The join is pushed again, under a tick of this device's own, when the record
//! lacks a live id or a removal the join holds: the server's copy may be the
//! sender's, and a device that pulls only that copy would never learn it. Two
//! core devices converge after one exchange, because the join of equal states
//! is the same state.

use std::collections::BTreeSet;

use rusqlite::Connection;
use serde_json::{Value, json};

use crate::api::errors::StorageError;
use crate::domain::task_merge::{self, Gate};
use crate::domain::tasks::Inbound;
use crate::domain::{journal, notes};
use crate::storage::nested_tx;
use crate::storage::repositories::schema::Object;
use crate::storage::repositories::sync_items::{self, InboundRecord};
use crate::storage::repositories::{Change, StoredPayload};
use crate::sync::clock;
use crate::sync::outbox;

const REFERENCES: &str = "attachmentReferences";
const REMOVED: &str = "removedAttachmentReferences";

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
    notes::insert_local(tx, notes::ITEM_TYPE, note_id, payload, now_ms)
}

/// The day's removals after a local edit from `before` to `after`: an id
/// dropped is removed, and an id added is live again on this device.
pub(crate) fn removals_after_edit(
    tx: &Connection,
    note_id: &str,
    before: &[String],
    after: &[String],
) -> Result<Option<(&'static str, Change)>, StorageError> {
    if !is_day_note(note_id) {
        return Ok(None);
    }
    let stored = stored_payload(tx, note_id)?.map(|payload| Lists::of(payload.object()));
    let held = stored.map(|lists| lists.removed).unwrap_or_default();
    let mut removed = held.clone();
    removed.extend(before.iter().filter(|id| !after.contains(id)).cloned());
    removed.retain(|id| !after.contains(id));
    Ok((removed != held).then(|| (REMOVED, Change::Set(json!(removed)))))
}

/// An inbound `note j<date>` record: the module docs' join, in one transaction
/// with the push it owes. The record's other fields follow §6.3.1's document
/// gate.
pub(crate) fn apply_remote(
    conn: &Connection,
    record: &InboundRecord,
    now_ms: i64,
    clock_device: Option<&str>,
) -> Result<Inbound, StorageError> {
    let tx = nested_tx::begin(conn).map_err(notes::failed)?;
    let gate = task_merge::document_gate(&tx, record)?;
    let local = stored_payload(&tx, &record.item_id)?;
    let remote = StoredPayload::parse(&record.payload_json)
        .ok()
        .filter(|_| record.deleted_at.is_none());
    let inbound = match (local, remote) {
        (Some(local), Some(remote)) => join(
            &tx,
            record,
            matches!(gate, Gate::Skip),
            &local,
            &remote,
            clock_device,
            now_ms,
        )?,
        _ => match gate {
            Gate::Skip => Inbound::Skipped,
            _ => task_merge::wholesale(&tx, record, now_ms)?,
        },
    };
    tx.commit().map_err(notes::failed)?;
    Ok(inbound)
}

/// Stores the join of `local` and `remote` on the payload the document gate
/// picks (`local` when it dominates), under both clocks merged, and queues
/// the push the sender is owed.
fn join(
    tx: &Connection,
    record: &InboundRecord,
    local_dominates: bool,
    local: &StoredPayload,
    remote: &StoredPayload,
    clock_device: Option<&str>,
    now_ms: i64,
) -> Result<Inbound, StorageError> {
    let (held, sent) = (Lists::of(local.object()), Lists::of(remote.object()));
    let joined = Lists::join(&held, &sent);
    if local_dominates && joined.same(&held) {
        return Ok(Inbound::Skipped);
    }
    let owed = !joined.within(&sent);
    let merged_clock = clock::merge(
        &notes::clock_in(local.object())?,
        &notes::clock_in(remote.object())?,
    );
    // A tick of this device's own makes the push a write no peer holds, so
    // two devices pushing the same join are not refused as replays.
    let stored_clock = match clock_device.filter(|_| owed) {
        Some(device) => clock::increment(&merged_clock, device),
        None => merged_clock,
    };
    let base = if local_dominates { local } else { remote };
    let mut changes = vec![
        (
            "clock",
            Change::Set(serde_json::to_value(&stored_clock).map_err(|error| {
                StorageError::Failed {
                    what: format!("clock will not serialise: {error}"),
                }
            })?),
        ),
        (REFERENCES, Change::Set(json!(joined.live))),
    ];
    if !joined.removed.is_empty() {
        changes.push((REMOVED, Change::Set(json!(joined.removed))));
    }
    let payload_json = base.merge(&changes);
    let inbound = task_merge::wholesale(
        tx,
        &InboundRecord {
            payload_json,
            ..record.clone()
        },
        now_ms,
    )?;
    if owed && matches!(inbound, Inbound::Applied) {
        outbox::enqueue(
            tx,
            &outbox::Change::upsert(notes::ITEM_TYPE, &record.item_id),
            now_ms,
        )?;
    }
    Ok(inbound)
}

/// A day's live ids and its removals. An absent list reads as empty: the
/// sender does not know (§14.7), so the list that is known stands.
#[derive(Debug, Default, PartialEq, Eq)]
struct Lists {
    live: Vec<String>,
    removed: Vec<String>,
}

impl Lists {
    fn of(payload: &Object) -> Lists {
        Lists {
            live: ids(payload, REFERENCES),
            removed: ids(payload, REMOVED),
        }
    }

    /// Live: `remote`'s, then `local`'s own, minus every removal of either.
    fn join(local: &Lists, remote: &Lists) -> Lists {
        let removed = union(&local.removed, &remote.removed);
        let live = union(&remote.live, &local.live)
            .into_iter()
            .filter(|id| !removed.contains(id))
            .collect();
        Lists { live, removed }
    }

    /// Whether `other` holds every live id and every removal of this one.
    fn within(&self, other: &Lists) -> bool {
        self.live.iter().all(|id| other.live.contains(id))
            && self.removed.iter().all(|id| other.removed.contains(id))
    }

    /// The same ids, in any order.
    fn same(&self, other: &Lists) -> bool {
        self.within(other) && other.within(self)
    }
}

fn ids(payload: &Object, key: &str) -> Vec<String> {
    let list = payload.get(key).and_then(Value::as_array);
    let mut seen = BTreeSet::new();
    list.into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|id| seen.insert(*id))
        .map(str::to_owned)
        .collect()
}

/// `first`, then the ids of `second` it lacks.
fn union(first: &[String], second: &[String]) -> Vec<String> {
    let mut all = first.to_vec();
    all.extend(second.iter().filter(|id| !first.contains(id)).cloned());
    all
}

/// The live, readable payload this device holds for the day, if any.
fn stored_payload(tx: &Connection, note_id: &str) -> Result<Option<StoredPayload>, StorageError> {
    let Some(row) = sync_items::load(tx, notes::ITEM_TYPE, note_id)? else {
        return Ok(None);
    };
    if row.deleted_at.is_some() || row.corrupt_reason.is_some() {
        return Ok(None);
    }
    Ok(row.payload.and_then(|raw| StoredPayload::parse(&raw).ok()))
}

#[cfg(test)]
mod tests;
