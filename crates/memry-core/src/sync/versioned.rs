//! Chapter 06 §6.11: a versioned map, `task.fields`.
//!
//! Each entry carries its own Lamport version `t` inside the value and merges
//! by it, independently of the document clock, so a stale echo from an older
//! peer cannot resurrect a value. Twin of `packages/shared/src/versioned.ts`
//! (`joinVersionedMap`, `stampVersionedMap`, `plainVersionedMap`), pinned by
//! the `versioned-values` vectors.
//!
//! `tag_definition.schema` is the other versioned key; this core stores it
//! verbatim and never edits it, so only the map half is here.

use std::cmp::Ordering;

use serde_json::{Map, Value, json};

use crate::sync::field_merge::canonical_json;

/// `x.t` when it is a safe integer `>= 0`, else 0 (`versioned.ts:33-37`).
/// JavaScript reads `3.0` and `1e3` as integers, so the test is on the float.
fn version_of(value: &Value) -> u64 {
    const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
    match value.get("t").and_then(Value::as_f64) {
        Some(t) if t.fract() == 0.0 && (0.0..=MAX_SAFE_INTEGER).contains(&t) => t as u64,
        _ => 0,
    }
}

/// The higher version wins; a tie goes to the greater canonical form,
/// compared as UTF-16 code units (`versioned.ts:74-80`).
pub fn compare(a: &Value, b: &Value) -> Ordering {
    version_of(a).cmp(&version_of(b)).then_with(|| {
        canonical_json(a)
            .encode_utf16()
            .cmp(canonical_json(b).encode_utf16())
    })
}

/// A map read off the wire: a non-object is absent, and an entry that is not
/// an object is dropped (§13.7.3.1).
pub fn read_map(value: Option<&Value>) -> Option<Map<String, Value>> {
    let entries = value?.as_object()?;
    Some(
        entries
            .iter()
            .filter(|(_, entry)| entry.is_object())
            .map(|(name, entry)| (name.clone(), entry.clone()))
            .collect(),
    )
}

fn entry_value(entry: Option<&Value>) -> Value {
    entry
        .and_then(|entry| entry.get("v"))
        .cloned()
        .unwrap_or(Value::Null)
}

/// The join of a local and a remote map, and what it means for each side.
#[derive(Debug, PartialEq)]
pub struct Joined {
    /// `None` when neither side holds a map.
    pub value: Option<Value>,
    /// The remote lacks something the join kept: a client that models the
    /// key re-pushes (§6.11.4).
    pub remote_behind: bool,
    /// The join differs from the local map.
    pub local_changed: bool,
}

/// Per field name, the winner of the two entries; an entry on one side only
/// is taken from that side. A remote `null` is no information
/// (`versioned.ts:114-135`).
pub fn join_map(local: Option<&Value>, remote: Option<&Value>) -> Joined {
    let mine = read_map(local);
    if remote.is_some_and(Value::is_null) {
        return Joined {
            value: mine.map(Value::Object),
            remote_behind: false,
            local_changed: false,
        };
    }
    let theirs = read_map(remote);
    if mine.is_none() && theirs.is_none() {
        return Joined {
            value: None,
            remote_behind: false,
            local_changed: false,
        };
    }
    let empty = Map::new();
    let ours = mine.as_ref().unwrap_or(&empty);
    let other = theirs.as_ref().unwrap_or(&empty);
    let mut result = Map::new();
    let mut remote_behind = false;
    let mut local_changed = mine.is_none();
    let names = ours
        .keys()
        .chain(other.keys().filter(|name| !ours.contains_key(*name)));
    for name in names {
        let (a, b) = (ours.get(name), other.get(name));
        let winner = match (a, b) {
            (Some(a), Some(b)) if compare(b, a) == Ordering::Greater => b,
            (Some(a), _) => a,
            (None, Some(b)) => b,
            (None, None) => continue,
        };
        remote_behind |= b.is_none_or(|b| compare(winner, b) != Ordering::Equal);
        local_changed |= a.is_none_or(|a| compare(winner, a) != Ordering::Equal);
        result.insert(name.clone(), winner.clone());
    }
    Joined {
        value: Some(Value::Object(result)),
        remote_behind,
        local_changed,
    }
}

/// A local edit: every key whose value changes is stamped with one
/// `t = max(clock_total, highest t in the map) + 1`; an unchanged key keeps
/// its entry, and an entry keeps the keys a newer build added (§6.11.3).
pub fn stamp_map(stored: Option<&Value>, patch: &Map<String, Value>, clock_total: u64) -> Value {
    let mut next = read_map(stored).unwrap_or_default();
    let stamp = next.values().map(version_of).fold(clock_total, u64::max) + 1;
    for (name, value) in patch {
        if canonical_json(&entry_value(next.get(name))) == canonical_json(value) {
            continue;
        }
        let mut entry = next
            .get(name)
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        entry.insert("v".to_owned(), value.clone());
        entry.insert("t".to_owned(), json!(stamp));
        next.insert(name.clone(), Value::Object(entry));
    }
    Value::Object(next)
}

/// The values a map holds, removals dropped (`plainVersionedMap`).
pub fn plain(stored: Option<&Value>) -> Map<String, Value> {
    read_map(stored)
        .unwrap_or_default()
        .into_iter()
        .map(|(name, entry)| (name, entry_value(Some(&entry))))
        .filter(|(_, value)| !value.is_null())
        .collect()
}
