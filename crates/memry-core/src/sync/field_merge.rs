//! Field-level merge, chapter 06 §6.3 through §6.8 (FR-002).
//!
//! This is the file where an ambiguity costs a user their edit, so every rule
//! is written out rather than implied.
//!
//! Three things are easy to get wrong and each has a test below:
//!
//! 1. **The winner is the larger tick sum, never [`compare`].** §6.5.3 freezes
//!    it: a device with more edits wins a concurrent pair regardless of
//!    causality. `compare` is computed and used **only** for the conflict flag.
//! 2. **The `_offline` tie-break is a key-presence test**, and it is
//!    **asymmetric**: there is no "remote has `_offline` and local does not"
//!    branch, because remote is the default winner on every tie. A "symmetric"
//!    rewrite breaks §6.5.1 cases 3a and 3b against desktop.
//! 3. **A concurrent pair with unequal totals is not a conflict** (§6.5.4). An
//!    edit is lost with nothing surfaced, deliberately and frozen. A core that
//!    reported it would write `superseded` activity rows desktop never writes,
//!    and those sync to every device.
//!
//! ## Value equality
//!
//! §6.4.2, **decision of 2026-09-13**, is the normative rule and it is what
//! this file implements: `differ` is computed over a **canonical form** —
//! recursively key-sorted objects, shortest-round-trip numbers with no
//! `1e+21` exponent special case, and `null` kept distinct from absent. The
//! shipped TypeScript still compares `JSON.stringify` output and is tracked as
//! **#2185**; where the two differ, the chapter wins (chapter 00 §0.1).
//!
//! The observable consequence is exactly one: two objects that differ only in
//! key order stop being reported as a conflict. No winner changes, and nothing
//! on the wire changes (§6.4.3).
//!
//! ## What this file does **not** do
//!
//! It does not push. §6.5.2 P3: after a merge apply the merging device stores
//! the union clock and **does not re-push**. There is no enqueue anywhere in
//! this module, and a reviewer should treat one appearing as the reintroduction
//! of §6.5.1 case 3c.

use std::collections::BTreeMap;

use serde_json::{Map as JsonMap, Value as Json};

use super::clock::{ClockOrder, VectorClock, clock_total, compare, has_offline_key, merge};

/// `TASK_SYNCABLE_FIELDS`, 15 entries **in order** (§6.7).
///
/// The order is part of the contract: `conflictedFields` is consumed in order
/// by activity logging (§6.5.3).
pub const TASK_SYNCABLE_FIELDS: [&str; 15] = [
    "title",
    "description",
    "projectId",
    "statusId",
    "parentId",
    "priority",
    "position",
    "dueDate",
    "dueTime",
    "startDate",
    "repeatConfig",
    "repeatFrom",
    "sourceNoteId",
    "completedAt",
    "archivedAt",
];

/// `PROJECT_SYNCABLE_FIELDS`, 9 entries in order (§6.7).
pub const PROJECT_SYNCABLE_FIELDS: [&str; 9] = [
    "name",
    "description",
    "color",
    "icon",
    "position",
    "isInbox",
    "archivedAt",
    "modifiedAt",
    "homeNoteId",
];

/// One reported conflict (§6.3 step 6).
///
/// The three values are `Option` because **absent is not `null`**: a field the
/// remote did not send has no `remoteValue` at all, and the distinction is what
/// `null-versus-undefined` pins.
#[derive(Debug, Clone, PartialEq)]
pub struct FieldConflict {
    pub field: String,
    pub local_value: Option<Json>,
    pub remote_value: Option<Json>,
    pub merged_value: Option<Json>,
    pub merged_clock: VectorClock,
}

/// What [`merge_fields`] produced.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct MergeResult {
    /// The winning value per field, **only where the winner is present**.
    /// §6.3 step 8: a winner of `undefined` leaves the caller's column
    /// untouched, which a missing key expresses and a stored `null` would not.
    pub merged: BTreeMap<String, Json>,
    /// `merge(L, R)` for **every** listed field, whichever branch won
    /// (§6.3 step 7) — including the fields neither side clocked, which come
    /// out as the empty clock.
    pub merged_field_clocks: BTreeMap<String, VectorClock>,
    pub had_conflicts: bool,
    /// In field-list order (§6.5.3).
    pub conflicted_fields: Vec<String>,
    pub conflicts: Vec<FieldConflict>,
}

/// The complete winner-selection rule of §6.3, per field, in list order.
pub fn merge_fields(
    local_data: &JsonMap<String, Json>,
    remote_data: &JsonMap<String, Json>,
    local_field_clocks: &BTreeMap<String, VectorClock>,
    remote_field_clocks: &BTreeMap<String, VectorClock>,
    syncable_fields: &[&str],
) -> MergeResult {
    let mut result = MergeResult::default();
    let empty = VectorClock::new();

    for field in syncable_fields {
        // Step 1. A missing field clock is the empty clock.
        let local_clock = local_field_clocks.get(*field).unwrap_or(&empty);
        let remote_clock = remote_field_clocks.get(*field).unwrap_or(&empty);

        // Step 2 and 3. `order` is computed here and reaches the winner
        // nowhere: it is read only by the conflict flag in step 6.
        let local_total = clock_total(local_clock);
        let remote_total = clock_total(remote_clock);
        let order = compare(local_clock, remote_clock);

        let local_value = local_data.get(*field);
        let remote_value = remote_data.get(*field);
        // Step 4, over §6.4.2's canonical form rather than `JSON.stringify`.
        let differ = canonical(local_value) != canonical(remote_value);

        // Step 5.
        let (winner, in_tie_branch) = if remote_total > local_total {
            (remote_value, false)
        } else if local_total > remote_total {
            (local_value, false)
        } else if has_offline_key(local_clock) && !has_offline_key(remote_clock) && differ {
            // The asymmetric key-presence test. `{_offline: 0}` counts.
            (local_value, true)
        } else {
            (remote_value, true)
        };

        // Step 7, unconditionally and on every field.
        let merged_clock = merge(local_clock, remote_clock);

        // Step 6, **only inside the tie branch**. §6.5.4: a concurrent pair
        // with unequal totals is resolved by the larger total and is silently
        // not a conflict.
        if in_tie_branch && order == ClockOrder::Concurrent && differ {
            result.had_conflicts = true;
            result.conflicted_fields.push((*field).to_owned());
            result.conflicts.push(FieldConflict {
                field: (*field).to_owned(),
                local_value: local_value.cloned(),
                remote_value: remote_value.cloned(),
                merged_value: winner.cloned(),
                merged_clock: merged_clock.clone(),
            });
        }

        // Step 8.
        if let Some(value) = winner {
            result.merged.insert((*field).to_owned(), value.clone());
        }
        result
            .merged_field_clocks
            .insert((*field).to_owned(), merged_clock);
    }

    result
}

/// The document-level gate that runs **before** [`merge_fields`] (§6.3.1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DocumentResolution {
    /// Apply the remote wholesale, storing its field clocks verbatim.
    Apply,
    /// The local clock dominates: skip the remote entirely.
    Skip,
    /// Concurrent. Merge, and store the union clock.
    Merge { merged_clock: VectorClock },
}

/// `resolveClockConflict(localClock, remoteClock)` (§6.3.1).
///
/// **Remote wins on `equal` here too**, which is the same default the field
/// tie-break has.
pub fn resolve_clock_conflict(
    local_clock: Option<&VectorClock>,
    remote_clock: &VectorClock,
) -> DocumentResolution {
    let Some(local_clock) = local_clock else {
        return DocumentResolution::Apply;
    };
    match compare(local_clock, remote_clock) {
        ClockOrder::After => DocumentResolution::Skip,
        ClockOrder::Concurrent => DocumentResolution::Merge {
            merged_clock: merge(local_clock, remote_clock),
        },
        ClockOrder::Before | ClockOrder::Equal => DocumentResolution::Apply,
    }
}

/// Seeds **every listed field** with a copy of the document clock (§6.7).
///
/// What a client uses when a row has a document clock but no field clocks yet.
pub fn init_all_field_clocks(
    doc_clock: &VectorClock,
    syncable_fields: &[&str],
) -> BTreeMap<String, VectorClock> {
    syncable_fields
        .iter()
        .map(|field| ((*field).to_owned(), doc_clock.clone()))
        .collect()
}

/// §6.4.2's canonical form, or `None` for an absent key.
///
/// `None` is JavaScript `undefined` and is distinct from `Some(Json::Null)`,
/// which is an explicit clear (chapter 13 §13.4).
fn canonical(value: Option<&Json>) -> Option<String> {
    value.map(|value| {
        let mut out = String::new();
        write_canonical(value, &mut out);
        out
    })
}

fn write_canonical(value: &Json, out: &mut String) {
    match value {
        Json::Null => out.push_str("null"),
        Json::Bool(true) => out.push_str("true"),
        Json::Bool(false) => out.push_str("false"),
        Json::Number(number) => {
            // Rule 2: every JSON number is one f64, formatted shortest
            // round-trip. Rust's `Display` for `f64` is exactly that and never
            // emits an exponent for the magnitudes JSON carries, which is the
            // `1e+21` special case the rule removes. `serde_json` cannot hold a
            // NaN or an infinity, so `as_f64` only fails on a `u64` past
            // `i64::MAX`, which the raw text covers exactly.
            match number.as_f64() {
                Some(f) => {
                    // `-0.0 == 0.0` in Rust, so this one comparison normalises
                    // both spellings of zero to one canonical form;
                    // `f64::to_string` would otherwise emit `-0`. Written as
                    // an `if` rather than a match guard because a float
                    // literal pattern is a future-compatibility warning.
                    if f == 0.0 {
                        out.push('0');
                    } else {
                        out.push_str(&f.to_string());
                    }
                }
                None => out.push_str(&number.to_string()),
            }
        }
        Json::String(text) => out.push_str(&Json::String(text.clone()).to_string()),
        Json::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_canonical(item, out);
            }
            out.push(']');
        }
        Json::Object(fields) => {
            // Rule 1: sort by the UTF-16 code-unit sequence, not by UTF-8
            // bytes. The two disagree above U+FFFF, where UTF-16 surrogates
            // sort below U+E000..U+FFFF and UTF-8 sorts above.
            let mut keys: Vec<&String> = fields.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            out.push('{');
            for (index, key) in keys.into_iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                out.push_str(&Json::String(key.clone()).to_string());
                out.push(':');
                // Rule 3: a key whose value is `null` is present and encodes as
                // `null`. There is no `undefined` inside a `serde_json` value,
                // so nothing is omitted here.
                write_canonical(&fields[key], out);
            }
            out.push('}');
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::clock::clock_of;
    use serde_json::json;

    fn object(value: Json) -> JsonMap<String, Json> {
        value.as_object().expect("a JSON object").clone()
    }

    fn field_clocks<const N: usize>(
        entries: [(&str, VectorClock); N],
    ) -> BTreeMap<String, VectorClock> {
        entries
            .into_iter()
            .map(|(field, clock)| (field.to_owned(), clock))
            .collect()
    }

    #[test]
    fn the_larger_tick_sum_wins_even_against_causality() {
        // §6.3.2 row 8: local total 4 beats remote total 3 though `compare`
        // says concurrent.
        let result = merge_fields(
            &object(json!({"title": "local"})),
            &object(json!({"title": "remote"})),
            &field_clocks([("title", clock_of([("device-a", 4)]))]),
            &field_clocks([(
                "title",
                clock_of([("device-a", 1), ("device-b", 1), ("device-c", 1)]),
            )]),
            &TASK_SYNCABLE_FIELDS,
        );
        assert_eq!(result.merged["title"], json!("local"));
        assert!(!result.had_conflicts, "unequal totals are never a conflict");
    }

    #[test]
    fn the_offline_tie_break_is_asymmetric() {
        let local = object(json!({"title": "local"}));
        let remote = object(json!({"title": "remote"}));
        let with_offline = field_clocks([(
            "title",
            clock_of([
                ("device-a", 1),
                (super::super::clock::OFFLINE_CLOCK_DEVICE_ID, 1),
            ]),
        )]);
        let plain = field_clocks([("title", clock_of([("device-b", 2)]))]);

        // Local carries `_offline`: local wins.
        let local_wins = merge_fields(&local, &remote, &with_offline, &plain, &["title"]);
        assert_eq!(local_wins.merged["title"], json!("local"));

        // Remote carries it instead: there is no branch for that, so remote
        // wins as the plain-tie default — the same answer from either seat.
        let remote_wins = merge_fields(&local, &remote, &plain, &with_offline, &["title"]);
        assert_eq!(remote_wins.merged["title"], json!("remote"));
    }

    #[test]
    fn the_canonical_form_makes_key_order_irrelevant_and_keeps_null_distinct() {
        assert_eq!(
            canonical(Some(&json!({"a": 1, "b": 2}))),
            canonical(Some(&json!({"b": 2, "a": 1}))),
            "#2185: object key order is not a difference"
        );
        assert_ne!(canonical(Some(&Json::Null)), canonical(None));
        assert_eq!(canonical(Some(&json!(1))), canonical(Some(&json!(1.0))));
        assert_ne!(
            canonical(Some(&json!(0.1 + 0.2))),
            canonical(Some(&json!(0.3))),
            "float accumulation is a real difference"
        );
    }

    #[test]
    fn the_document_gate_lets_remote_win_on_equal() {
        let clock = clock_of([("device-a", 1)]);
        assert_eq!(
            resolve_clock_conflict(Some(&clock), &clock),
            DocumentResolution::Apply
        );
        assert_eq!(
            resolve_clock_conflict(None, &clock),
            DocumentResolution::Apply
        );
        assert_eq!(
            resolve_clock_conflict(Some(&clock_of([("device-a", 2)])), &clock),
            DocumentResolution::Skip
        );
        assert_eq!(
            resolve_clock_conflict(Some(&clock_of([("device-b", 1)])), &clock),
            DocumentResolution::Merge {
                merged_clock: clock_of([("device-a", 1), ("device-b", 1)])
            }
        );
    }

    #[test]
    fn every_listed_field_gets_a_merged_clock_and_unlisted_fields_are_untouched() {
        let result = merge_fields(
            &object(json!({"title": "local", "notSyncable": "kept"})),
            &object(json!({"title": "remote", "notSyncable": "ignored"})),
            &field_clocks([("title", clock_of([("device-a", 1)]))]),
            &field_clocks([("title", clock_of([("device-a", 2)]))]),
            &TASK_SYNCABLE_FIELDS,
        );
        assert_eq!(result.merged_field_clocks.len(), TASK_SYNCABLE_FIELDS.len());
        assert_eq!(
            result.merged_field_clocks["description"],
            VectorClock::new()
        );
        assert!(!result.merged.contains_key("notSyncable"));
    }
}
