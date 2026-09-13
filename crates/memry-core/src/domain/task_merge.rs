//! The inbound half of the two field-merged types: §6.3.1's document gate,
//! §6.3's per-field winner rule, and the clock bookkeeping a local edit needs
//! (T129, FR-002, FR-059).
//!
//! Split out of [`crate::domain::tasks`] only to stay under the 600-line
//! ceiling. `task` and `project` share every line of it — the two differ by
//! nothing but their field list (§6.7) — so it is written once rather than
//! twice, and the list is a parameter.
//!
//! **The merge rule itself is [`crate::sync::field_merge`] and is not restated
//! here**: it is pinned byte for byte by the `field-merge` vector class, and a
//! second copy of the rule is a second thing to get wrong. What this module
//! adds is the storage around it.
//!
//! Three obligations, and the first is the load-bearing one.
//!
//! - **No enqueue, ever.** §6.5.2's P3: after a merge apply the merging device
//!   stores the union clock and does **not** re-push. A re-push here
//!   reintroduces the §6.5.1 case-3c divergence deterministically, not as a
//!   race, so a reviewer should treat a [`crate::sync::outbox::enqueue`]
//!   appearing in this file as exactly that regression.
//! - **A stored clock that will not parse is a hard error, never an empty
//!   clock.** An empty one lowers `clockTotal` and changes the winner (§6.10),
//!   so reading one as `{}` silently hands the next concurrent peer the win on
//!   every field. FR-032 states the rule for a zero-row first page; it applies
//!   to every reader.
//! - **`_offline` never reaches a payload written here.**
//!   `next_field_clocks` refuses the reserved device id outright, which is
//!   §6.6 made structural rather than remembered.

use std::collections::BTreeMap;

use rusqlite::{Connection, params};
use serde_json::Value;

use crate::api::errors::StorageError;
use crate::domain::notes::failed;
use crate::domain::tasks::Inbound;
use crate::storage::repositories::schema::Object;
use crate::storage::repositories::sync_items::InboundRecord;
use crate::storage::repositories::{Change, StoredPayload, sync_items};
use crate::sync::clock::{self, OFFLINE_CLOCK_DEVICE_ID, VectorClock};
use crate::sync::field_merge::{
    DocumentResolution, init_all_field_clocks, merge_fields, resolve_clock_conflict,
};

/// [`apply_remote`] for either field-merged type (§6.8).
pub(crate) fn apply_remote_merged(
    conn: &Connection,
    record: &InboundRecord,
    fields: &[&str],
    now_ms: i64,
) -> Result<Inbound, StorageError> {
    // A tombstone never reaches a parser at all — the applier short-circuits
    // the delete before decoding the body (§13.7.2) — so it never reaches the
    // merge either.
    if record.deleted_at.is_some() {
        return wholesale(conn, record, now_ms);
    }
    let Some(local) = live_payload(conn, record)? else {
        return wholesale(conn, record, now_ms);
    };
    let Ok(remote) = StoredPayload::parse(&record.payload_json) else {
        // Not this module's to diagnose: the generic path stores the bytes and
        // records the reason against the row (§13.2 rule 5).
        return wholesale(conn, record, now_ms);
    };

    let local_clock = stored_clock(local.object())?;
    let remote_clock = stored_clock(remote.object())?.unwrap_or_default();
    let merged_clock = match resolve_clock_conflict(local_clock.as_ref(), &remote_clock) {
        DocumentResolution::Apply => return wholesale(conn, record, now_ms),
        DocumentResolution::Skip => return Ok(Inbound::Skipped),
        DocumentResolution::Merge { merged_clock } => merged_clock,
    };

    let result = merge_fields(
        local.object(),
        remote.object(),
        &stored_field_clocks(local.object(), "local")?,
        &stored_field_clocks(remote.object(), "remote")?,
        fields,
    );

    // §6.3 step 8: a winner of `undefined` leaves the column untouched, which
    // a missing key in `merged` expresses. A field outside `fields` is not
    // merged at all (§6.7), so the local value survives — including `tags` and
    // the two link arrays on a task.
    let mut changes: Vec<(&str, Change)> = fields
        .iter()
        .filter_map(|field| {
            result
                .merged
                .get(*field)
                .map(|value| (*field, Change::Set(value.clone())))
        })
        .collect();
    changes.push(("clock", Change::Set(as_json(&merged_clock)?)));
    changes.push((
        "fieldClocks",
        Change::Set(as_json(&result.merged_field_clocks)?),
    ));

    // One transaction, and **no outbox row**: §6.5.2 P3, the merging device
    // stores the union clock and does not re-push.
    let transaction = conn.unchecked_transaction().map_err(failed)?;
    sync_items::apply_local_edit_in(
        &transaction,
        &record.item_type,
        &record.item_id,
        &changes,
        now_ms,
    )?;
    // The bookkeeping the wholesale path would have written. `deleted_at` is
    // untouched: this branch cannot be a tombstone.
    transaction
        .execute(
            "UPDATE sync_items SET server_cursor = ?3, signer_device_id = ?4, updated_at = ?5
             WHERE item_type = ?1 AND item_id = ?2",
            params![
                record.item_type,
                record.item_id,
                record.server_cursor,
                record.signer_device_id,
                record.updated_at,
            ],
        )
        .map_err(failed)?;
    transaction.commit().map_err(failed)?;

    Ok(Inbound::Merged {
        conflicted_fields: result.conflicted_fields,
    })
}

/// The stored payload of a live row that has one, or `None` when there is
/// nothing local to merge against.
fn live_payload(
    conn: &Connection,
    record: &InboundRecord,
) -> Result<Option<StoredPayload>, StorageError> {
    let Some(row) = sync_items::load(conn, &record.item_type, &record.item_id)? else {
        return Ok(None);
    };
    let Some(raw) = row.payload else {
        return Ok(None);
    };
    // A local row that will not parse is already flagged corrupt; the remote
    // is the better copy, so it applies wholesale rather than failing the pull.
    Ok(StoredPayload::parse(&raw).ok())
}

/// §6.3.1's apply branch: the remote's bytes and its field clocks, verbatim.
fn wholesale(
    conn: &Connection,
    record: &InboundRecord,
    now_ms: i64,
) -> Result<Inbound, StorageError> {
    Ok(match sync_items::apply_remote(conn, record, now_ms)? {
        sync_items::ApplyOutcome::Applied => Inbound::Applied,
        sync_items::ApplyOutcome::Corrupt { reason } => Inbound::Corrupt { reason },
        // The wholesale path runs no document gate, so it has no skip of its
        // own to report; the §6.3.1 skip is decided above, before this call.
        sync_items::ApplyOutcome::Skipped => Inbound::Skipped,
        // `task_activity` is the only expiring type (§13.12) and it is neither
        // of the two field-merged ones, so this arm is unreachable here.
        sync_items::ApplyOutcome::Expired => Inbound::Skipped,
    })
}

/// `fieldClocks` with each changed **listed** field ticked for this device.
///
/// A stored `fieldClocks` that will not parse is a **hard error**: reading it
/// as an empty map would restart every field's tick and hand the next
/// concurrent peer all fifteen wins. FR-032 states that rule for a zero-row
/// first page and it applies to every reader.
pub(crate) fn next_field_clocks(
    stored: &Object,
    fields: &[&str],
    touched: &[&str],
    device_id: &str,
) -> Result<Value, StorageError> {
    if device_id.is_empty() || device_id == OFFLINE_CLOCK_DEVICE_ID {
        return Err(StorageError::Failed {
            what: format!("`{device_id}` is not a usable device id (chapter 06 §6.6)"),
        });
    }
    let mut clocks = match stored.get("fieldClocks") {
        // §6.7: a row with a document clock and no field clocks seeds every
        // listed field from the document clock.
        None | Some(Value::Null) => {
            init_all_field_clocks(&stored_clock(stored)?.unwrap_or_default(), fields)
        }
        Some(value) => parse_field_clocks(value, "stored")?,
    };
    for field in touched {
        if !fields.contains(field) {
            continue;
        }
        let current = clocks.get(*field).cloned().unwrap_or_default();
        clocks.insert((*field).to_owned(), clock::increment(&current, device_id));
    }
    as_json(&clocks)
}

/// A payload's `clock`, or `None` when the key is absent or `null`.
///
/// An unparseable clock is an error and never an empty clock: an empty one
/// lowers `clockTotal` and changes the winner (§6.10).
fn stored_clock(stored: &Object) -> Result<Option<VectorClock>, StorageError> {
    match stored.get("clock") {
        None | Some(Value::Null) => Ok(None),
        Some(value) => serde_json::from_value(value.clone())
            .map(Some)
            .map_err(|error| StorageError::Failed {
                what: format!("stored clock is not a vector clock: {error}"),
            }),
    }
}

fn stored_field_clocks(
    stored: &Object,
    whose: &str,
) -> Result<BTreeMap<String, VectorClock>, StorageError> {
    match stored.get("fieldClocks") {
        None | Some(Value::Null) => Ok(BTreeMap::new()),
        Some(value) => parse_field_clocks(value, whose),
    }
}

fn parse_field_clocks(
    value: &Value,
    whose: &str,
) -> Result<BTreeMap<String, VectorClock>, StorageError> {
    serde_json::from_value(value.clone()).map_err(|error| StorageError::Failed {
        what: format!("{whose} fieldClocks is not a map of vector clocks: {error}"),
    })
}

pub(crate) fn as_clock(value: &Value) -> Result<VectorClock, StorageError> {
    serde_json::from_value(value.clone()).map_err(|error| StorageError::Failed {
        what: format!("clock will not parse back: {error}"),
    })
}

fn as_json<T: serde::Serialize>(value: &T) -> Result<Value, StorageError> {
    serde_json::to_value(value).map_err(|error| StorageError::Failed {
        what: format!("clock will not serialise: {error}"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::field_merge::TASK_SYNCABLE_FIELDS;
    use serde_json::json;

    fn stored(value: Value) -> Object {
        crate::domain::notes::object(value)
    }

    #[test]
    fn a_row_with_no_field_clocks_seeds_all_fifteen_from_the_document_clock() {
        let clocks = next_field_clocks(
            &stored(json!({"clock": {"device-a": 3}})),
            &TASK_SYNCABLE_FIELDS,
            &["title"],
            "device-a",
        )
        .expect("field clocks");

        let parsed = clocks.as_object().expect("an object");
        assert_eq!(parsed.len(), TASK_SYNCABLE_FIELDS.len());
        // Seeded from the document clock, then ticked for the one change.
        assert_eq!(parsed["title"], json!({"device-a": 4}));
        assert_eq!(parsed["dueDate"], json!({"device-a": 3}));
    }

    #[test]
    fn only_the_changed_listed_fields_tick() {
        let clocks = next_field_clocks(
            &stored(json!({"fieldClocks": {"title": {"device-a": 1}}})),
            &TASK_SYNCABLE_FIELDS,
            &["title", "modifiedAt", "tags"],
            "device-b",
        )
        .expect("field clocks");

        let parsed = clocks.as_object().expect("an object");
        assert_eq!(parsed["title"], json!({"device-a": 1, "device-b": 1}));
        // `modifiedAt` and `tags` are outside `TASK_SYNCABLE_FIELDS` (§6.7),
        // so neither gets a clock — and an unlisted field is not merged at all.
        assert!(!parsed.contains_key("modifiedAt"));
        assert!(!parsed.contains_key("tags"));
    }

    #[test]
    fn modified_at_ticks_on_the_type_that_merges_it() {
        use crate::sync::field_merge::PROJECT_SYNCABLE_FIELDS;

        let clocks = next_field_clocks(
            &stored(json!({"fieldClocks": {}})),
            &PROJECT_SYNCABLE_FIELDS,
            &["name", "modifiedAt"],
            "device-a",
        )
        .expect("field clocks");

        let parsed = clocks.as_object().expect("an object");
        assert_eq!(parsed["modifiedAt"], json!({"device-a": 1}));
    }

    #[test]
    fn an_unreadable_field_clock_map_is_an_error_and_never_an_empty_one() {
        assert!(
            next_field_clocks(
                &stored(json!({"fieldClocks": {"title": {"device-a": "two"}}})),
                &TASK_SYNCABLE_FIELDS,
                &["title"],
                "device-a",
            )
            .is_err()
        );
        assert!(stored_clock(&stored(json!({"clock": 7}))).is_err());
    }

    #[test]
    fn the_reserved_offline_id_cannot_reach_a_field_clock() {
        assert!(
            next_field_clocks(
                &stored(json!({})),
                &TASK_SYNCABLE_FIELDS,
                &["title"],
                OFFLINE_CLOCK_DEVICE_ID,
            )
            .is_err()
        );
    }
}
