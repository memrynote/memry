//! The `field-merge` conformance class, chapter 06 (FR-002, SC-001).
//!
//! Thirty-two cases in three sections: twenty merges, eight clock-algebra
//! operations and four `_offline` rebinds. The committed JSON is the only
//! input — rule 2 of `packages/contracts/test-vectors/README.md` — and nothing
//! here recomputes an expectation.
//!
//! ## The canonical-comparison case no longer needs an override
//!
//! `object-values-same-content-different-key-order` used to be asserted
//! against chapter 06 §6.4.2 rather than against the file, because the shipped
//! TypeScript still compared `JSON.stringify` output and reported `{a:1,b:2}`
//! against `{b:2,a:1}` as a conflict. #2185 landed in `packages/sync-client`
//! (`fix(sync-client): compare field values canonically instead of
//! JSON.stringify`), the generator re-emitted the case with
//! `hadConflicts: false`, and the override was deleted as its own comment
//! predicted. The case is now asserted from the file like every other one.

mod support;

use std::collections::BTreeMap;

use memry_core::sync::clock::{
    ClockOrder, VectorClock, compare, increment, merge, rebind_clock_device, rebind_field_clocks,
};
use memry_core::sync::field_merge::{
    MergeResult, PROJECT_SYNCABLE_FIELDS, TASK_SYNCABLE_FIELDS, merge_fields,
};
use serde_json::{Map as JsonMap, Value as Json, json};
use support::vector_file;

#[test]
fn field_merge_cases_match_the_committed_vectors() {
    let file = vector_file("field-merge");
    let cases = file["cases"].as_array().expect("cases is an array");
    assert_eq!(cases.len(), 20, "the merge section is twenty cases");

    for case in cases {
        let name = case["name"].as_str().expect("every case is named");
        let fields: &[&str] = match case["syncableFields"].as_str() {
            Some("TASK") => &TASK_SYNCABLE_FIELDS,
            Some("PROJECT") => &PROJECT_SYNCABLE_FIELDS,
            other => panic!("{name}: unknown field list {other:?}"),
        };

        let result = merge_fields(
            &object(&case["localData"]),
            &object(&case["remoteData"]),
            &field_clocks(&case["localFieldClocks"]),
            &field_clocks(&case["remoteFieldClocks"]),
            fields,
        );

        let expected = &case["expected"];
        assert_eq!(
            Json::Object(result.merged.clone().into_iter().collect()),
            expected["merged"],
            "{name}: merged values"
        );
        assert_eq!(
            clocks_to_json(&result.merged_field_clocks),
            expected["mergedFieldClocks"],
            "{name}: merged field clocks"
        );

        assert_eq!(
            json!(result.had_conflicts),
            expected["hadConflicts"],
            "{name}: hadConflicts"
        );
        assert_eq!(
            json!(result.conflicted_fields),
            expected["conflictedFields"],
            "{name}: conflictedFields, in field-list order"
        );
        assert_eq!(
            conflicts_to_json(&result),
            expected["conflicts"],
            "{name}: conflicts"
        );
    }
}

#[test]
fn the_clock_algebra_cases_match_the_committed_vectors() {
    let file = vector_file("field-merge");
    let cases = file["clockAlgebra"]
        .as_array()
        .expect("clockAlgebra is an array");
    assert_eq!(cases.len(), 8, "the algebra section is eight cases");

    for case in cases {
        let name = case["name"].as_str().expect("every case is named");
        let a = clock(&case["a"]);
        match case["op"].as_str() {
            Some("compare") => {
                let order = compare(&a, &clock(&case["b"]));
                assert_eq!(
                    order.as_str(),
                    case["expected"].as_str().expect("a string verdict"),
                    "{name}: compare"
                );
                // The verdict is over the union of both key sets, so the
                // reverse direction is its mirror. Asserted because a loop
                // that iterates one side's keys only passes the forward half.
                let mirrored = compare(&clock(&case["b"]), &a);
                assert_eq!(mirrored, mirror(order), "{name}: compare is antisymmetric");
            }
            Some("merge") => {
                let b = clock(&case["b"]);
                assert_eq!(
                    clock_to_json(&merge(&a, &b)),
                    case["expected"]["forward"],
                    "{name}: merge"
                );
                assert_eq!(
                    clock_to_json(&merge(&b, &a)),
                    case["expected"]["reversed"],
                    "{name}: merge commutes"
                );
            }
            Some("increment") => {
                let device = case["deviceId"].as_str().expect("increment names a device");
                assert_eq!(
                    clock_to_json(&increment(&a, device)),
                    case["expected"],
                    "{name}: increment"
                );
            }
            other => panic!("{name}: unknown clock operation {other:?}"),
        }
    }
}

#[test]
fn the_offline_rebind_cases_match_the_committed_vectors() {
    let file = vector_file("field-merge");
    let cases = file["offlineRebind"]
        .as_array()
        .expect("offlineRebind is an array");
    assert_eq!(cases.len(), 4, "the rebind section is four cases");

    for case in cases {
        let name = case["name"].as_str().expect("every case is named");
        let target = case["targetDeviceId"]
            .as_str()
            .expect("a rebind names a target");
        assert_eq!(
            clock_to_json(&rebind_clock_device(&clock(&case["clock"]), target)),
            case["expected"]["clock"],
            "{name}: document clock"
        );
        assert_eq!(
            clocks_to_json(&rebind_field_clocks(
                &field_clocks(&case["fieldClocks"]),
                target
            )),
            case["expected"]["fieldClocks"],
            "{name}: field clocks"
        );
    }
}

#[test]
fn the_field_lists_are_the_chapter_six_lists_in_order() {
    let file = vector_file("field-merge");
    assert_eq!(
        json!(TASK_SYNCABLE_FIELDS),
        file["meta"]["TASK_SYNCABLE_FIELDS"]
    );
    assert_eq!(
        json!(PROJECT_SYNCABLE_FIELDS),
        file["meta"]["PROJECT_SYNCABLE_FIELDS"]
    );
    assert_eq!(file["meta"]["offlineDeviceId"], json!("_offline"));
}

fn object(value: &Json) -> JsonMap<String, Json> {
    value.as_object().cloned().unwrap_or_default()
}

fn clock(value: &Json) -> VectorClock {
    object(value)
        .into_iter()
        .map(|(device, tick)| (device, tick.as_u64().expect("a tick is a u64")))
        .collect()
}

fn field_clocks(value: &Json) -> BTreeMap<String, VectorClock> {
    object(value)
        .into_iter()
        .map(|(field, ticks)| (field, clock(&ticks)))
        .collect()
}

fn clock_to_json(clock: &VectorClock) -> Json {
    Json::Object(
        clock
            .iter()
            .map(|(device, tick)| (device.clone(), json!(tick)))
            .collect(),
    )
}

fn clocks_to_json(clocks: &BTreeMap<String, VectorClock>) -> Json {
    Json::Object(
        clocks
            .iter()
            .map(|(field, clock)| (field.clone(), clock_to_json(clock)))
            .collect(),
    )
}

/// The conflict shape the vectors record. An absent value is an **omitted
/// key**, not a `null`: `null-versus-undefined` is the case that pins the
/// difference.
fn conflicts_to_json(result: &MergeResult) -> Json {
    Json::Array(
        result
            .conflicts
            .iter()
            .map(|conflict| {
                let mut fields = JsonMap::new();
                fields.insert("field".to_owned(), json!(conflict.field));
                if let Some(value) = &conflict.local_value {
                    fields.insert("localValue".to_owned(), value.clone());
                }
                if let Some(value) = &conflict.remote_value {
                    fields.insert("remoteValue".to_owned(), value.clone());
                }
                if let Some(value) = &conflict.merged_value {
                    fields.insert("mergedValue".to_owned(), value.clone());
                }
                fields.insert(
                    "mergedClock".to_owned(),
                    clock_to_json(&conflict.merged_clock),
                );
                Json::Object(fields)
            })
            .collect(),
    )
}

fn mirror(order: ClockOrder) -> ClockOrder {
    match order {
        ClockOrder::Equal => ClockOrder::Equal,
        ClockOrder::Before => ClockOrder::After,
        ClockOrder::After => ClockOrder::Before,
        ClockOrder::Concurrent => ClockOrder::Concurrent,
    }
}
