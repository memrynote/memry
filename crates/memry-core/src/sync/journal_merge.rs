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
//!   past the stamp; that side is then read as written whole at its clock,
//!   which is its floor on every unit.
//! - `fieldClocksFloor` covers every unit `fieldClocks` does not name: the
//!   payload supersedes each write to it at or before the floor.
//!   `fieldFloors` overrides that floor for the units it names. A record
//!   applied whole while untrusted is stored stamped with no unit clock and
//!   its clock as the floor, so the next edit pushes its removals (#5572). A
//!   record clock never becomes a unit clock: only a trusted side's stamped
//!   units are writes.
//! - A merge whose fields differ from the remote's is stored at the union
//!   clock ticked for this device and re-queued in the same transaction
//!   (§6.5.2 P3), as `settings_merge` does; one that holds the remote's fields
//!   is stored at the union clock and not pushed.

use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Map, Value};

use crate::api::errors::StorageError;
use crate::domain::notes::failed;
use crate::domain::tags::tag_key;
use crate::domain::task_merge::{self, Gate, as_clock};
use crate::domain::tasks::Inbound;
use crate::storage::nested_tx;
use crate::storage::repositories::{Change, InboundRecord, StoredPayload};
use crate::sync::clock::{ClockOrder, VectorClock, compare, increment, merge};
use crate::sync::field_merge::{canonical_json, payloads_identical};
use crate::sync::outbox;

const TAG: &str = "tags.";
const PROPERTY: &str = "properties.";
const STAMP_KEYS: [&str; 4] = [
    "fieldClocks",
    "fieldClocksAt",
    "fieldClocksFloor",
    "fieldFloors",
];

type UnitClocks = BTreeMap<String, VectorClock>;

/// A merged pair, the clock it is stored at, and its stamp (§6.12.3).
#[derive(Debug, Clone, PartialEq)]
pub struct JournalMerge {
    pub tags: Vec<Value>,
    pub properties: Map<String, Value>,
    pub clock: VectorClock,
    /// The merged fields differ from the remote's, so the merge is pushed.
    pub requeue: bool,
    /// The `fieldClocks`, `fieldClocksAt`, `fieldClocksFloor` and
    /// `fieldFloors` keys; an empty floor or floor map is left out.
    pub stamp: Map<String, Value>,
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

/// `desktop`'s `valuesEqual`: §6.4.2 canonical equality, `None` only to `None`.
fn same(a: Option<&Value>, b: Option<&Value>) -> bool {
    a.map(canonical_json) == b.map(canonical_json)
}

fn doc_clock(side: &Map<String, Value>) -> Result<VectorClock, StorageError> {
    match side.get("clock") {
        None | Some(Value::Null) => Ok(VectorClock::new()),
        Some(value) => as_clock(value),
    }
}

fn parsed<T: serde::de::DeserializeOwned>(side: &Map<String, Value>, key: &str) -> Option<T> {
    serde_json::from_value(side.get(key)?.clone()).ok()
}

/// A side's clocks as §6.12.1 reads them.
struct Side {
    clock: VectorClock,
    /// The stamped unit clocks, or `None` when they cannot be trusted: an
    /// older build ticked `clock` past `fieldClocksAt`, or there are none.
    stamped: Option<UnitClocks>,
    floor: Option<VectorClock>,
    floors: UnitClocks,
}

impl Side {
    fn read(side: &Map<String, Value>) -> Result<Self, StorageError> {
        let clock = doc_clock(side)?;
        let at: Option<VectorClock> = parsed(side, "fieldClocksAt");
        let stamped =
            parsed::<UnitClocks>(side, "fieldClocks").filter(|_| at == Some(clock.clone()));
        Ok(Self {
            floor: parsed(side, "fieldClocksFloor"),
            floors: parsed(side, "fieldFloors").unwrap_or_default(),
            clock,
            stamped,
        })
    }

    /// The floor every unit this side does not clock reads.
    fn record_floor(&self) -> VectorClock {
        match self.stamped {
            Some(_) => self.floor.clone().unwrap_or_default(),
            None => self.clock.clone(),
        }
    }

    /// The floor this side reads for `unit`; an untrusted side's is its clock.
    fn unit_floor(&self, unit: &str) -> Option<VectorClock> {
        match self.stamped {
            Some(_) => self.floors.get(unit).or(self.floor.as_ref()).cloned(),
            None => Some(self.clock.clone()),
        }
    }

    fn write(&self, unit: &str) -> Option<&VectorClock> {
        self.stamped.as_ref()?.get(unit)
    }
}

/// The stamp keys; an empty floor or floor map is left out.
fn stamp(
    clocks: &UnitClocks,
    at: &VectorClock,
    floor: Option<&VectorClock>,
    floors: &UnitClocks,
) -> Result<Map<String, Value>, StorageError> {
    let mut out = Map::new();
    out.insert("fieldClocks".to_owned(), clock_json(clocks)?);
    out.insert("fieldClocksAt".to_owned(), clock_json(at)?);
    if let Some(floor) = floor.filter(|floor| !floor.is_empty()) {
        out.insert("fieldClocksFloor".to_owned(), clock_json(floor)?);
    }
    if !floors.is_empty() {
        out.insert("fieldFloors".to_owned(), clock_json(floors)?);
    }
    Ok(out)
}

/// The payload changes that write `stamp`; a key it lacks is dropped.
fn stamp_changes(stamp: &Map<String, Value>) -> Vec<(&'static str, Change)> {
    STAMP_KEYS
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
/// stamp keys. Each unit whose value changed takes `next`'s clock; the rest
/// keep theirs, and so do the base's floor and the unit floors of unchanged
/// units. An untrusted base clocks no unit, and its clock is the floor. With
/// no base the writer cannot tell which units it wrote since it last synced,
/// so the edit carries none.
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
    let side = Side::read(base)?;
    let (mut clocks, floor, kept) = match side.stamped {
        Some(stamped) => (stamped, side.floor, side.floors),
        None => (UnitClocks::new(), Some(side.clock), UnitClocks::new()),
    };
    let before = units(base);
    let after = units(next);
    let all: BTreeSet<&String> = before.iter().chain(after.iter()).map(|(u, _)| u).collect();
    for unit in all {
        if !same(lookup(&before, unit), lookup(&after, unit)) {
            clocks.insert(unit.clone(), clock.clone());
        }
    }
    let floors = kept
        .into_iter()
        .filter(|(unit, _)| !clocks.contains_key(unit))
        .collect();
    stamp(&clocks, &clock, floor.as_ref(), &floors)
}

/// §6.12.1: the unit clocks a device keeps with `remote` applied whole
/// (§6.3.1 `before` or `equal`, or a first sighting). A trusted remote keeps
/// its own (`None`). An untrusted one was written whole at its clock, so it
/// clocks no unit and its clock is the floor: the next edit from it carries
/// its removals, and none of its units outranks a concurrent write.
pub fn field_clocks_for_wholesale(
    remote: &Map<String, Value>,
) -> Result<Option<Map<String, Value>>, StorageError> {
    let side = Side::read(remote)?;
    if side.stamped.is_some() {
        return Ok(None);
    }
    stamp(
        &UnitClocks::new(),
        &side.clock,
        Some(&side.clock),
        &UnitClocks::new(),
    )
    .map(Some)
}

/// §6.12.1: a floor supersedes every write it has seen, so it reads at its
/// clock against the other side's claim on a unit only when it strictly
/// dominates that claim, or there is none.
fn floor_against(floor: Option<&VectorClock>, other: Option<&VectorClock>) -> Option<VectorClock> {
    let floor = floor?;
    match other {
        Some(other) if compare(other, floor) != ClockOrder::Before => None,
        _ => Some(floor.clone()),
    }
}

fn clock_total(clock: &VectorClock) -> u64 {
    clock.values().sum()
}

/// §6.12.3: whether the local write beats a concurrent remote one. More ticks
/// win; on a tie a value beats an absence, then the greater canonical value
/// wins, compared as JavaScript compares strings (UTF-16 code units).
fn local_wins_tie(
    local_clock: &VectorClock,
    remote_clock: &VectorClock,
    local: Option<&Value>,
    remote: Option<&Value>,
) -> bool {
    match clock_total(local_clock).cmp(&clock_total(remote_clock)) {
        Ordering::Greater => return true,
        Ordering::Less => return false,
        Ordering::Equal => {}
    }
    let (Some(local), Some(remote)) = (local, remote) else {
        return remote.is_none();
    };
    let (local, remote) = (canonical_json(local), canonical_json(remote));
    local.encode_utf16().cmp(remote.encode_utf16()) == Ordering::Greater
}

/// Tags sorted by their canonical form, for a set comparison.
fn sorted(tags: &[Value]) -> Vec<String> {
    let mut out: Vec<String> = tags.iter().map(canonical_json).collect();
    out.sort();
    out
}

/// §6.12.3: a concurrent pair merges per unit. A unit's claim is a trusted
/// side's stamped clock, or its floor where the floor dominates the other
/// side's claim. A claim that dominates the other wins; two concurrent claims
/// tie-break on ticks then value; with no claim on either side the remote's
/// value stands. A winner with no value removes the unit. Local survivors
/// keep local order and spelling, then remote-only survivors follow in remote
/// order.
///
/// A unit no stamped write won keeps the floor its value supersedes: both
/// floors when the sides agree, else the winner's alone, in `fieldFloors`
/// where it differs from the record floor (#5508 (a)).
///
/// A result that holds the remote's fields is the remote's record: it keeps
/// the remote's order, is stored at the union clock and is not pushed. Any
/// other result is stored at the union ticked by `device` and re-queued.
pub fn merge_journal_fields(
    local: &Map<String, Value>,
    remote: &Map<String, Value>,
    device: &str,
) -> Result<JournalMerge, StorageError> {
    let local_units = units(local);
    let remote_units = units(remote);
    let named = |side: &Map<String, Value>, units: &[(String, Value)]| -> Vec<String> {
        let clocked = match side.get("fieldClocks") {
            Some(Value::Object(clocks)) => clocks.keys().cloned().collect(),
            _ => Vec::new(),
        };
        units
            .iter()
            .map(|(unit, _)| unit.clone())
            .chain(clocked)
            .collect()
    };
    let all: BTreeSet<String> = named(local, &local_units)
        .into_iter()
        .chain(named(remote, &remote_units))
        .collect();
    let l = Side::read(local)?;
    let r = Side::read(remote)?;
    // Every unit neither side names reads as absent on both, so the merged
    // payload supersedes what either record floor did.
    let record_floor = merge(&l.record_floor(), &r.record_floor());

    let mut merged: BTreeMap<&str, Value> = BTreeMap::new();
    let mut field_clocks = UnitClocks::new();
    let mut field_floors = UnitClocks::new();
    for unit in &all {
        let local_value = lookup(&local_units, unit);
        let remote_value = lookup(&remote_units, unit);
        let local_write = l.write(unit);
        let remote_write = r.write(unit);
        let local_floor = l.unit_floor(unit);
        let remote_floor = r.unit_floor(unit);
        let local_claim = local_write.cloned().or_else(|| {
            floor_against(local_floor.as_ref(), remote_write.or(remote_floor.as_ref()))
        });
        let remote_claim = remote_write
            .cloned()
            .or_else(|| floor_against(remote_floor.as_ref(), local_write.or(local_floor.as_ref())));
        let local_wins = match (&local_claim, &remote_claim) {
            (Some(_), None) => true,
            (Some(local_claim), Some(remote_claim)) => match compare(local_claim, remote_claim) {
                ClockOrder::After => true,
                ClockOrder::Concurrent => {
                    local_wins_tie(local_claim, remote_claim, local_value, remote_value)
                }
                _ => false,
            },
            _ => false,
        };
        let value = if local_wins {
            local_value
        } else {
            remote_value
        };
        if let Some(value) = value {
            merged.insert(unit, value.clone());
        }
        let agree = same(local_value, remote_value);
        // A stamped winner keeps its own write clock: the loser's is no write
        // of this value. Two writes of one value keep both.
        let (write, other) = if local_wins {
            (local_write, remote_write)
        } else {
            (remote_write, local_write)
        };
        if let Some(write) = write {
            let clock = match other.filter(|_| agree) {
                Some(other) => merge(write, other),
                None => write.clone(),
            };
            field_clocks.insert(unit.clone(), clock);
            continue;
        }
        let floor = if agree {
            merge(
                &local_floor.unwrap_or_default(),
                &remote_floor.unwrap_or_default(),
            )
        } else if local_wins {
            local_floor.unwrap_or_default()
        } else {
            remote_floor.unwrap_or_default()
        };
        if compare(&floor, &record_floor) != ClockOrder::Equal {
            field_floors.insert(unit.clone(), floor);
        }
    }

    let order = local_units.iter().map(|(u, _)| u).chain(
        remote_units
            .iter()
            .map(|(u, _)| u)
            .filter(|u| lookup(&local_units, u).is_none()),
    );
    let mut tags = Vec::new();
    let mut properties = Map::new();
    for unit in order {
        let Some(winner) = merged.get(unit.as_str()) else {
            continue;
        };
        if unit.starts_with(TAG) {
            let tag = lookup(&local_units, unit).unwrap_or(winner);
            if tag.is_string() {
                tags.push(tag.clone());
            }
        } else if let Some(key) = unit.strip_prefix(PROPERTY) {
            properties.insert(key.to_owned(), winner.clone());
        }
    }
    let remote_tags = match remote.get("tags") {
        Some(Value::Array(tags)) => tags.clone(),
        _ => Vec::new(),
    };
    let remote_properties = match remote.get("properties") {
        Some(Value::Object(properties)) => properties.clone(),
        _ => Map::new(),
    };
    let same_properties = |properties: &Map<String, Value>| {
        canonical_json(&Value::Object(properties.clone()))
            == canonical_json(&Value::Object(remote_properties.clone()))
    };
    if sorted(&tags) == sorted(&remote_tags) && same_properties(&properties) {
        tags.clone_from(&remote_tags);
        properties.clone_from(&remote_properties);
    }
    let requeue = !(Value::Array(tags.clone()) == Value::Array(remote_tags.clone())
        && same_properties(&properties));
    let union = merge(&l.clock, &r.clock);
    let clock = if requeue {
        increment(&union, device)
    } else {
        union
    };
    let stamp = stamp(&field_clocks, &clock, Some(&record_floor), &field_floors)?;
    Ok(JournalMerge {
        tags,
        properties,
        clock,
        requeue,
        stamp,
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
/// unit and takes every other key from the remote. A merge that changed the
/// remote's fields is stored at the union ticked for `clock_device`, this
/// device's clock id, and re-queued; any other is stored at the union.
pub(crate) fn apply_remote(
    conn: &rusqlite::Connection,
    record: &InboundRecord,
    now_ms: i64,
    clock_device: Option<&str>,
) -> Result<Inbound, StorageError> {
    let (local, remote) = match task_merge::document_gate(conn, record)? {
        Gate::Wholesale => return apply_whole(conn, record, now_ms),
        Gate::Skip => return Ok(Inbound::Skipped),
        Gate::Merge { local, remote, .. } => (local, remote),
    };
    let merged = merge_journal_fields(
        local.object(),
        remote.object(),
        clock_device.unwrap_or_default(),
    )?;
    // A re-queued merge is ticked for this device (§6.12.3); a pull with no
    // clock id stores nothing rather than a merge its push cannot clock.
    if merged.requeue && clock_device.is_none_or(str::is_empty) {
        return Err(StorageError::Failed {
            what: format!(
                "journal {} merged and this pull has no device clock id to push it under",
                record.item_id
            ),
        });
    }
    let mut changes = stamp_changes(&merged.stamp);
    changes.extend([
        ("tags", Change::Set(Value::Array(merged.tags))),
        ("properties", Change::Set(Value::Object(merged.properties))),
        ("clock", Change::Set(clock_json(&merged.clock)?)),
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
