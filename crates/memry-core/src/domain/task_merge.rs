//! The inbound half of a record apply: §6.3.1's document gate, §6.3's
//! per-field winner rule, and the clock bookkeeping a local edit needs
//! (T129, FR-002, FR-059).
//!
//! Split out of [`crate::domain::tasks`] only to stay under the 600-line
//! ceiling, and named for the field-merged pair it started as. `task` and
//! `project` share every line of the per-field half — the two differ by
//! nothing but their field list (§6.7) — so it is written once rather than
//! twice, and the list is a parameter.
//!
//! **[`document_gate`] is not theirs alone.** §6.3.1 runs before `mergeFields`
//! for those two *and* is the whole of the algorithm for §6.8's "every other
//! subscribed type", so the gate lives here once and
//! [`crate::sync::apply`] hands both rows of that table to it. A second copy
//! of the comparison is a second thing to get wrong, and the failure mode of
//! getting it wrong is a stale remote overwriting a newer local row.
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
    DocumentResolution, init_all_field_clocks, merge_fields, payloads_identical,
    resolve_clock_conflict,
};

/// What §6.3.1's document-level gate decided about one inbound record.
///
/// The gate is **both** rows of §6.8's table: the field-merged pair runs it
/// before `mergeFields`, and every other subscribed type has nothing under it
/// and stops here. One enum and one evaluation, so the two cannot drift — the
/// prologue below is as load-bearing as the comparison itself.
pub(crate) enum Gate {
    /// §6.3.1 rows 1 and 4, plus the cases with nothing to compare: apply the
    /// remote wholesale, its field clocks stored verbatim.
    Wholesale,
    /// §6.3.1 row 2 (`after`): the local clock dominates, or §6.5.2 P4's
    /// equal clock over an identical payload. The remote is not applied at
    /// all and nothing is written.
    Skip,
    /// §6.3.1 row 3 (`concurrent`): `merged_clock` is `merge(local, remote)`.
    Merge {
        local: StoredPayload,
        remote: StoredPayload,
        merged_clock: VectorClock,
    },
}

/// Runs §6.3.1's gate for one inbound record.
///
/// Three short-circuits come before the comparison, and each is a rule rather
/// than an optimisation:
///
/// - **A tombstone bypasses the gate entirely** (§6.9.2, §13.7.2). A deleted
///   row has no fields and carries no clock, and gating one on a clock it does
///   not have would record a delete as corrupt.
/// - **Nothing local to compare against is §6.3.1's first row**: the local
///   clock is absent, so the remote applies wholesale.
/// - **A remote that will not parse is not this gate's to diagnose**: the
///   wholesale path stores the bytes and records the reason against the row
///   (§13.2 rule 5).
///
/// A stored **local** clock that will not parse is an `Err`, never an empty
/// clock: an empty local clock reads as "local is absent", which hands a stale
/// remote the win on every field (§6.10). The caller records it corrupt.
pub(crate) fn document_gate(
    conn: &Connection,
    record: &InboundRecord,
) -> Result<Gate, StorageError> {
    if record.deleted_at.is_some() {
        return Ok(Gate::Wholesale);
    }
    let Some((local, pushable)) = live_payload(conn, record)? else {
        return Ok(Gate::Wholesale);
    };
    let Ok(remote) = StoredPayload::parse(&record.payload_json) else {
        return Ok(Gate::Wholesale);
    };

    let local_clock = stored_clock(local.object())?;
    let remote_clock = stored_clock(remote.object())?.unwrap_or_default();
    // §6.5.2 P4 (#2294): an equal clock is a skip only when the row this
    // device would push is the row being pulled. The stored payload is the
    // push payload (P2), so it is the comparison; a deleted or corrupt local
    // row cannot answer, so it applies.
    let identical = || pushable && payloads_identical(local.object(), remote.object());
    Ok(
        match resolve_clock_conflict(local_clock.as_ref(), &remote_clock, identical) {
            DocumentResolution::Apply => Gate::Wholesale,
            DocumentResolution::Skip => Gate::Skip,
            DocumentResolution::Merge { merged_clock } => Gate::Merge {
                local,
                remote,
                merged_clock,
            },
        },
    )
}

/// The remote's payload with §6.3.1's union clock written into it.
///
/// §6.8's document-level resolver has no per-field decision to make, so its
/// `concurrent` branch is exactly "the remote's payload, under the merged
/// clock". It goes through [`StoredPayload::merge`] so a key this build does
/// not model rides along (§13.2 rule 3), and the `clock` **column** follows
/// the payload rather than being set beside it — a column that disagreed with
/// the bytes would be overwritten by the next local edit and the union lost.
pub(crate) fn with_clock(
    payload: &StoredPayload,
    clock: &VectorClock,
) -> Result<String, StorageError> {
    Ok(payload.merge(&[("clock", Change::Set(as_json(clock)?))]))
}

/// [`apply_remote`] for either field-merged type (§6.8).
pub(crate) fn apply_remote_merged(
    conn: &Connection,
    record: &InboundRecord,
    fields: &[&str],
    now_ms: i64,
) -> Result<Inbound, StorageError> {
    let (local, remote, merged_clock) = match document_gate(conn, record)? {
        Gate::Wholesale => return wholesale(conn, record, now_ms),
        Gate::Skip => return Ok(Inbound::Skipped),
        Gate::Merge {
            local,
            remote,
            merged_clock,
        } => (local, remote, merged_clock),
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

/// The stored payload of a row that has one, or `None` when there is nothing
/// local to merge against, and whether that payload is what a push would send
/// (the row is neither deleted nor flagged corrupt).
fn live_payload(
    conn: &Connection,
    record: &InboundRecord,
) -> Result<Option<(StoredPayload, bool)>, StorageError> {
    let Some(row) = sync_items::load(conn, &record.item_type, &record.item_id)? else {
        return Ok(None);
    };
    let pushable = row.deleted_at.is_none() && row.corrupt_reason.is_none();
    let Some(raw) = row.payload else {
        return Ok(None);
    };
    // A local row that will not parse is already flagged corrupt; the remote
    // is the better copy, so it applies wholesale rather than failing the pull.
    Ok(StoredPayload::parse(&raw)
        .ok()
        .map(|payload| (payload, pushable)))
}

/// §6.3.1's apply branch: the remote's bytes and its field clocks, verbatim.
pub(crate) fn wholesale(
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
