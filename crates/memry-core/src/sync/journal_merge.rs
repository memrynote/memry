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
//!   past the stamp; a remote side is then read as written whole at its
//!   clock, which is the document rule it ran. An untrusted local side proves
//!   no unit clock, so the remote wins each of its units.
//! - `fieldClocksFloor` covers every unit `fieldClocks` does not name: the
//!   payload supersedes each write to it at or before the floor. A record
//!   applied whole while untrusted is stored stamped with no unit clock and
//!   its clock as the floor, so the next edit pushes its removals (#5572). A
//!   record clock never becomes a unit clock: only a trusted side's stamped
//!   units are writes.
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
use crate::storage::repositories::{Change, InboundRecord, StoredPayload};
use crate::sync::clock::{ClockOrder, VectorClock, compare, merge};
use crate::sync::field_merge::{canonical_json, merge_fields, payloads_identical};
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
    pub field_clocks_floor: Option<VectorClock>,
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

/// A trusted side's floor; one that will not parse is no floor.
fn stamped_floor(side: &Map<String, Value>) -> Option<VectorClock> {
    serde_json::from_value(side.get("fieldClocksFloor")?.clone()).ok()
}

/// Every unit a side names in its value or its `fieldClocks`, trusted or not.
fn named(side: &Map<String, Value>) -> Vec<String> {
    let clocked = match side.get("fieldClocks") {
        Some(Value::Object(clocks)) => clocks.keys().cloned().collect(),
        _ => Vec::new(),
    };
    units(side)
        .into_iter()
        .map(|(unit, _)| unit)
        .chain(clocked)
        .collect()
}

/// A trusted side's stamped unit clocks and floor (§6.12.1), or `None`.
fn trusted_clocks(
    side: &Map<String, Value>,
) -> Result<Option<(UnitClocks, Option<VectorClock>)>, StorageError> {
    let clock = doc_clock(side)?;
    Ok(trusted_map(side, &clock).map(|map| (map, stamped_floor(side))))
}

/// The `fieldClocks`, `fieldClocksAt` and `fieldClocksFloor` keys; an empty
/// floor is left out.
fn stamp(
    clocks: &UnitClocks,
    at: &VectorClock,
    floor: Option<&VectorClock>,
) -> Result<Map<String, Value>, StorageError> {
    let mut out = Map::new();
    out.insert("fieldClocks".to_owned(), clock_json(clocks)?);
    out.insert("fieldClocksAt".to_owned(), clock_json(at)?);
    if let Some(floor) = floor.filter(|floor| !floor.is_empty()) {
        out.insert("fieldClocksFloor".to_owned(), clock_json(floor)?);
    }
    Ok(out)
}

/// The payload changes that write `stamp`; a key it lacks is dropped.
fn stamp_changes(stamp: &Map<String, Value>) -> Vec<(&'static str, Change)> {
    ["fieldClocks", "fieldClocksAt", "fieldClocksFloor"]
        .into_iter()
        .map(|key| {
            (
                key,
                stamp.get(key).cloned().map_or(Change::Remove, Change::Set),
            )
        })
        .collect()
}

/// §6.12.2: the unit clocks a local edit from `base` to `next` pushes, as the
/// `fieldClocks`, `fieldClocksAt` and `fieldClocksFloor` keys. With no base the
/// writer cannot tell which units it wrote since it last synced, so the edit
/// carries none.
pub fn field_clocks_for_edit(
    base: Option<&Map<String, Value>>,
    next: &Map<String, Value>,
) -> Result<Option<Map<String, Value>>, StorageError> {
    base.map(|base| edit_stamp(base, next)).transpose()
}

fn edit_stamp(
    base: &Map<String, Value>,
    next: &Map<String, Value>,
) -> Result<Map<String, Value>, StorageError> {
    let clock = doc_clock(next)?;
    // An untrusted base was written whole at its clock: it clocks no unit,
    // and its clock is the floor.
    let (mut clocks, floor) = match trusted_clocks(base)? {
        Some(trusted) => trusted,
        None => (UnitClocks::new(), Some(doc_clock(base)?)),
    };
    let before = units(base);
    let after = units(next);
    let all: BTreeSet<&String> = before.iter().chain(after.iter()).map(|(u, _)| u).collect();
    for unit in all {
        let old = lookup(&before, unit).map(canonical_json);
        let new = lookup(&after, unit).map(canonical_json);
        if old != new {
            clocks.insert(unit.clone(), clock.clone());
        }
    }
    stamp(&clocks, &clock, floor.as_ref())
}

/// §6.12.1: the unit clocks a device keeps with `remote` applied whole
/// (§6.3.1 `before` or `equal`, or a first sighting). A trusted remote keeps
/// its own (`None`). An untrusted one was written whole at its clock, so it
/// clocks no unit and its clock is the floor: the next edit from it carries
/// its removals, and none of its units outranks a concurrent write.
pub fn field_clocks_for_wholesale(
    remote: &Map<String, Value>,
) -> Result<Option<Map<String, Value>>, StorageError> {
    let clock = doc_clock(remote)?;
    if trusted_map(remote, &clock).is_some() {
        return Ok(None);
    }
    stamp(&UnitClocks::new(), &clock, Some(&clock)).map(Some)
}

/// §6.12.1: a floor supersedes a write it has seen, so it reads at its clock
/// against a unit clock it strictly dominates, or a side with no clock for the
/// unit. A write concurrent with it is one the floor's writer never saw.
fn floor_against(floor: Option<&VectorClock>, other: Option<&VectorClock>) -> Option<VectorClock> {
    let floor = floor?;
    match other {
        Some(other) if compare(other, floor) != ClockOrder::Before => None,
        _ => Some(floor.clone()),
    }
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
    let all: BTreeSet<String> = named(local).into_iter().chain(named(remote)).collect();
    // §6.12.1: an untrusted local side proves nothing. Its `clock` carries
    // this device's ticks since it last synced, body-only saves included, so
    // the remote wins each unit, as the document rule applies a concurrent
    // remote whole. An untrusted remote reads at its clock on every unit, the
    // document rule it ran.
    let (local_stamped, local_floor) = trusted_clocks(local)?.unwrap_or_default();
    let remote_trusted = trusted_clocks(remote)?;
    let remote_wrote = remote_trusted.is_some();
    let (remote_stamped, remote_floor) = match remote_trusted {
        Some(trusted) => trusted,
        None => {
            let clock = doc_clock(remote)?;
            let whole = all.iter().map(|unit| (unit.clone(), clock.clone()));
            (whole.collect(), Some(clock))
        }
    };
    let mut local_clocks = UnitClocks::new();
    let mut remote_clocks = UnitClocks::new();
    // Units a trusted side wrote and no floor superseded: only these keep a
    // clock, so a record's clock never turns into a write.
    let mut written = Vec::new();
    for unit in &all {
        let (local_unit, remote_unit) = (local_stamped.get(unit), remote_stamped.get(unit));
        let local_floored = match local_unit {
            Some(_) => None,
            None => floor_against(local_floor.as_ref(), remote_unit.or(remote_floor.as_ref())),
        };
        let remote_floored = match remote_unit {
            Some(_) => None,
            None => floor_against(remote_floor.as_ref(), local_unit.or(local_floor.as_ref())),
        };
        let wrote = local_unit.is_some() || (remote_wrote && remote_unit.is_some());
        if wrote && local_floored.is_none() && remote_floored.is_none() {
            written.push(unit);
        }
        let local_clock = local_unit.cloned().or(local_floored);
        let remote_clock = remote_unit.cloned().or(remote_floored);
        local_clocks.extend(local_clock.map(|clock| (unit.clone(), clock)));
        remote_clocks.extend(remote_clock.map(|clock| (unit.clone(), clock)));
    }
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
    // Every unit neither side names reads as absent on both, so the merged
    // payload supersedes what either floor did.
    let floor = merge(
        &local_floor.unwrap_or_default(),
        &remote_floor.unwrap_or_default(),
    );
    let field_clocks = written
        .into_iter()
        .filter_map(|unit| {
            let clock = result.merged_field_clocks.get(unit)?;
            Some((unit.clone(), clock.clone()))
        })
        .collect();
    Ok(JournalMerge {
        tags,
        properties,
        field_clocks,
        field_clocks_floor: (!floor.is_empty()).then_some(floor),
        requeue,
    })
}

/// The unit clock changes a local journal edit adds, diffed from the stored
/// payload to the merged one (§6.12.2). Every write through
/// `apply_local_edit_in` restamps, so the stamp follows `clock`.
pub(crate) fn local_edit_changes(
    stored: &Map<String, Value>,
    merged: &Map<String, Value>,
) -> Result<Vec<(&'static str, Change)>, StorageError> {
    Ok(stamp_changes(&edit_stamp(stored, merged)?))
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
        Gate::Wholesale => return apply_whole(conn, record, now_ms),
        Gate::Skip => return Ok(Inbound::Skipped),
        Gate::Merge {
            local,
            remote,
            merged_clock,
        } => (local, remote, merged_clock),
    };
    let merged = merge_journal_fields(local.object(), remote.object())?;
    let stamped = stamp(
        &merged.field_clocks,
        &merged_clock,
        merged.field_clocks_floor.as_ref(),
    )?;
    let mut changes = stamp_changes(&stamped);
    changes.extend([
        ("tags", Change::Set(Value::Array(merged.tags))),
        ("properties", Change::Set(Value::Object(merged.properties))),
        ("clock", Change::Set(clock_json(&merged_clock)?)),
    ]);
    let payload_json = remote.merge(&changes);
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

/// §6.3.1's apply branch, stamped by §6.12.1: an untrusted remote is stored
/// with [`field_clocks_for_wholesale`]'s stamp (#5572). A tombstone, a
/// remote that will not parse, or one whose clock will not read goes through
/// as it arrived, for the wholesale path to store and diagnose (§13.2 rule 5).
fn apply_whole(
    conn: &rusqlite::Connection,
    record: &InboundRecord,
    now_ms: i64,
) -> Result<Inbound, StorageError> {
    let remote = match StoredPayload::parse(&record.payload_json) {
        Ok(remote) if record.deleted_at.is_none() => remote,
        _ => return task_merge::wholesale(conn, record, now_ms),
    };
    let Ok(Some(stamped)) = field_clocks_for_wholesale(remote.object()) else {
        return task_merge::wholesale(conn, record, now_ms);
    };
    let payload_json = remote.merge(&stamp_changes(&stamped));
    // §6.5.2 P4: the record this device already applied whole, re-pulled.
    if let Some((local, true)) = &task_merge::live_payload(conn, record)?
        && StoredPayload::parse(&payload_json)
            .is_ok_and(|stamped| payloads_identical(local.object(), stamped.object()))
    {
        return Ok(Inbound::Skipped);
    }
    let stamped_record = InboundRecord {
        payload_json,
        ..record.clone()
    };
    task_merge::wholesale(conn, &stamped_record, now_ms)
}

fn clock_json<T: serde::Serialize>(value: &T) -> Result<Value, StorageError> {
    serde_json::to_value(value).map_err(|error| StorageError::Failed {
        what: format!("journal field clocks will not serialise: {error}"),
    })
}
