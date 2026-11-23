//! Journal `tags` and `properties` merge per unit (chapter 06 §6.12, #5508).
//!
//! The port of `packages/sync-client/src/journal-merge.ts`; the
//! `journal-merge` vectors pin the two against each other. Every other journal
//! key keeps §6.3.1's document rule.
//!
//! - A unit is `tags.<tag_key>` or `properties.<key>`. Its clock is the
//!   document clock at which a device last wrote it, so a unit clock never
//!   exceeds the clock of the payload that carries it. A unit clocked but
//!   absent from the value is a removal.
//! - A side's `fieldClocks` are trusted only when `fieldClocksAt` equals its
//!   `clock` (§6.12.1). An older build keeps the keys (§13.2) but ticks `clock`
//!   past the stamp; its side is then read as written whole at its clock,
//!   which is the document rule it ran.
//! - A merge whose local unit clock is concurrent with or ahead of the
//!   remote's re-queues the merged payload in the same transaction
//!   (§6.5.2 P3), as `settings_merge` does.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Map, Value};

use crate::api::errors::StorageError;
use crate::domain::notes::failed;
use crate::domain::tags::tag_key;
use crate::domain::task_merge::{self, Gate, as_clock};
use crate::domain::tasks::Inbound;
use crate::storage::nested_tx;
use crate::storage::repositories::{Change, InboundRecord};
use crate::sync::clock::{ClockOrder, VectorClock, compare};
use crate::sync::field_merge::{canonical_json, merge_fields};
use crate::sync::outbox;

const TAG: &str = "tags.";
const PROPERTY: &str = "properties.";

type UnitClocks = BTreeMap<String, VectorClock>;

/// The merged `tags`, `properties` and unit clocks of a concurrent pair.
#[derive(Debug, Clone, PartialEq)]
pub struct JournalMerge {
    pub tags: Vec<Value>,
    pub properties: Map<String, Value>,
    pub field_clocks: UnitClocks,
    pub requeue: bool,
}

/// Units in value order; a case variant of an earlier tag is the same unit.
fn units(side: &Map<String, Value>) -> Vec<(String, Value)> {
    let mut out: Vec<(String, Value)> = Vec::new();
    if let Some(Value::Array(tags)) = side.get("tags") {
        for tag in tags.iter().filter_map(Value::as_str) {
            let unit = format!("{TAG}{}", tag_key(tag));
            if !out.iter().any(|(seen, _)| *seen == unit) {
                out.push((unit, Value::String(tag.to_owned())));
            }
        }
    }
    if let Some(Value::Object(properties)) = side.get("properties") {
        for (key, value) in properties {
            out.push((format!("{PROPERTY}{key}"), value.clone()));
        }
    }
    out
}

fn lookup<'a>(units: &'a [(String, Value)], unit: &str) -> Option<&'a Value> {
    units.iter().find(|(seen, _)| seen == unit).map(|(_, v)| v)
}

fn doc_clock(side: &Map<String, Value>) -> Result<VectorClock, StorageError> {
    match side.get("clock") {
        None | Some(Value::Null) => Ok(VectorClock::new()),
        Some(value) => as_clock(value),
    }
}

/// The stamped map, or `None` when the side's unit clocks cannot be trusted.
fn trusted_map(side: &Map<String, Value>, clock: &VectorClock) -> Option<UnitClocks> {
    let stamp: VectorClock = serde_json::from_value(side.get("fieldClocksAt")?.clone()).ok()?;
    let map: UnitClocks = serde_json::from_value(side.get("fieldClocks")?.clone()).ok()?;
    (stamp == *clock).then_some(map)
}

/// The unit names a side's `fieldClocks` carries, trusted or not.
fn clocked_units(side: &Map<String, Value>) -> Vec<String> {
    match side.get("fieldClocks") {
        Some(Value::Object(clocks)) => clocks.keys().cloned().collect(),
        _ => Vec::new(),
    }
}

/// §6.12.1: a side's unit clocks. An untrusted side was written whole at its
/// clock: every unit in `union`, and every unit it names, takes that clock, so
/// a unit it lacks is a removal rather than an unclocked absence.
pub fn journal_unit_clocks(
    side: &Map<String, Value>,
    union: &BTreeSet<String>,
) -> Result<UnitClocks, StorageError> {
    let clock = doc_clock(side)?;
    if let Some(map) = trusted_map(side, &clock) {
        return Ok(map);
    }
    let named = clocked_units(side)
        .into_iter()
        .chain(units(side).into_iter().map(|(unit, _)| unit));
    Ok(union
        .iter()
        .cloned()
        .chain(named)
        .map(|unit| (unit, clock.clone()))
        .collect())
}

/// §6.12.2: the unit clocks a local edit from `base` to `next` pushes, as the
/// `fieldClocks` and `fieldClocksAt` values. No base seeds every unit at
/// `next`'s clock.
pub fn field_clocks_for_edit(
    base: Option<&Map<String, Value>>,
    next: &Map<String, Value>,
) -> Result<(Value, Value), StorageError> {
    let clock = doc_clock(next)?;
    let seed;
    let from = match base {
        Some(base) => base,
        None => {
            let mut only = next.clone();
            only.shift_remove("fieldClocks");
            only.shift_remove("fieldClocksAt");
            seed = only;
            &seed
        }
    };
    let mut clocks = journal_unit_clocks(from, &BTreeSet::new())?;
    let before = units(from);
    let after = units(next);
    let all: BTreeSet<&String> = before.iter().chain(after.iter()).map(|(u, _)| u).collect();
    for unit in all {
        let old = lookup(&before, unit).map(canonical_json);
        let new = lookup(&after, unit).map(canonical_json);
        if old != new {
            clocks.insert(unit.clone(), clock.clone());
        }
    }
    Ok((clock_json(&clocks)?, clock_json(&clock)?))
}

/// §6.12.3: a concurrent pair merges per unit by §6.3's rule; a winner with no
/// value removes the unit. Local survivors keep local order and spelling, then
/// remote-only survivors follow in remote order.
pub fn merge_journal_fields(
    local: &Map<String, Value>,
    remote: &Map<String, Value>,
) -> Result<JournalMerge, StorageError> {
    let local_units = units(local);
    let remote_units = units(remote);
    let all: BTreeSet<String> = clocked_units(local)
        .into_iter()
        .chain(clocked_units(remote))
        .chain(local_units.iter().map(|(u, _)| u.clone()))
        .chain(remote_units.iter().map(|(u, _)| u.clone()))
        .collect();
    let local_clocks = journal_unit_clocks(local, &all)?;
    let remote_clocks = journal_unit_clocks(remote, &all)?;
    let fields: Vec<&str> = all.iter().map(String::as_str).collect();
    let as_map =
        |units: &[(String, Value)]| -> Map<String, Value> { units.iter().cloned().collect() };
    let result = merge_fields(
        &as_map(&local_units),
        &as_map(&remote_units),
        &local_clocks,
        &remote_clocks,
        &fields,
    );

    let order = local_units.iter().map(|(u, _)| u).chain(
        remote_units
            .iter()
            .map(|(u, _)| u)
            .filter(|u| lookup(&local_units, u).is_none()),
    );
    let mut tags = Vec::new();
    let mut properties = Map::new();
    for unit in order {
        let Some(winner) = result.merged.get(unit) else {
            continue;
        };
        if unit.starts_with(TAG) {
            tags.push(lookup(&local_units, unit).unwrap_or(winner).clone());
        } else if let Some(key) = unit.strip_prefix(PROPERTY) {
            properties.insert(key.to_owned(), winner.clone());
        }
    }

    let empty = VectorClock::new();
    let requeue = all.iter().any(|unit| {
        let order = compare(
            local_clocks.get(unit).unwrap_or(&empty),
            remote_clocks.get(unit).unwrap_or(&empty),
        );
        matches!(order, ClockOrder::Concurrent | ClockOrder::After)
    });
    Ok(JournalMerge {
        tags,
        properties,
        field_clocks: result.merged_field_clocks,
        requeue,
    })
}

/// The `fieldClocks` and `fieldClocksAt` changes a local journal edit adds,
/// diffed from the stored payload to the merged one (§6.12.2). Every write
/// through `apply_local_edit_in` restamps, so the stamp follows `clock`.
pub(crate) fn local_edit_changes(
    stored: &Map<String, Value>,
    merged: &Map<String, Value>,
) -> Result<[(&'static str, Change); 2], StorageError> {
    let (clocks, at) = field_clocks_for_edit(Some(stored), merged)?;
    Ok([
        ("fieldClocks", Change::Set(clocks)),
        ("fieldClocksAt", Change::Set(at)),
    ])
}

/// §6.12.3 on the pull: `before` and `equal` apply wholesale and `after`
/// skips, as §6.3.1 has it; `concurrent` merges `tags` and `properties` per
/// unit, takes every other key from the remote under the union clock, and
/// re-queues when a local unit is not behind the remote's.
pub(crate) fn apply_remote(
    conn: &rusqlite::Connection,
    record: &InboundRecord,
    now_ms: i64,
) -> Result<Inbound, StorageError> {
    let (local, remote, merged_clock) = match task_merge::document_gate(conn, record)? {
        Gate::Wholesale => return task_merge::wholesale(conn, record, now_ms),
        Gate::Skip => return Ok(Inbound::Skipped),
        Gate::Merge {
            local,
            remote,
            merged_clock,
        } => (local, remote, merged_clock),
    };
    let merged = merge_journal_fields(local.object(), remote.object())?;
    let clock = clock_json(&merged_clock)?;
    let payload_json = remote.merge(&[
        ("tags", Change::Set(Value::Array(merged.tags))),
        ("properties", Change::Set(Value::Object(merged.properties))),
        (
            "fieldClocks",
            Change::Set(clock_json(&merged.field_clocks)?),
        ),
        ("fieldClocksAt", Change::Set(clock.clone())),
        ("clock", Change::Set(clock)),
    ]);
    let merged_record = InboundRecord {
        payload_json,
        ..record.clone()
    };

    let transaction = nested_tx::begin(conn).map_err(failed)?;
    let inbound = task_merge::wholesale(&transaction, &merged_record, now_ms)?;
    if merged.requeue && matches!(inbound, Inbound::Applied) {
        outbox::enqueue(
            &transaction,
            &outbox::Change::upsert(&record.item_type, &record.item_id),
            now_ms,
        )?;
    }
    transaction.commit().map_err(failed)?;
    Ok(inbound)
}

fn clock_json<T: serde::Serialize>(value: &T) -> Result<Value, StorageError> {
    serde_json::to_value(value).map_err(|error| StorageError::Failed {
        what: format!("journal field clocks will not serialise: {error}"),
    })
}
