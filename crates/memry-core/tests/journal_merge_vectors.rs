//! The `journal-merge` class (chapter 06 §6.12, #5508): every case of
//! `journal-merge.json` against `sync::journal_merge`. The committed JSON is
//! the only input.

mod support;

use memry_core::sync::journal_merge::{field_clocks_for_edit, merge_journal_fields};
use serde_json::{Value as Json, json};
use support::vector_file;

fn cases(section: &str) -> Vec<Json> {
    let cases = vector_file("journal-merge")[section]
        .as_array()
        .unwrap_or_else(|| panic!("journal-merge.json has no `{section}` array"))
        .clone();
    assert!(
        !cases.is_empty(),
        "journal-merge.json section `{section}` is empty"
    );
    cases
}

fn name(case: &Json) -> &str {
    case["name"].as_str().expect("every case is named")
}

#[test]
fn the_case_count_is_the_recorded_one() {
    let file = vector_file("journal-merge");
    let total = cases("edits").len() + cases("merges").len();
    assert_eq!(total as u64, file["meta"]["caseCount"]);
}

#[test]
fn every_edit_case_clocks_the_units_desktop_clocks() {
    for case in cases("edits") {
        let base = case["base"].as_object();
        let next = case["next"].as_object().expect("next is an object");
        let (clocks, at) = field_clocks_for_edit(base, next).expect("clocks read");
        assert_eq!(
            json!({ "fieldClocks": clocks, "fieldClocksAt": at }),
            case["expected"],
            "{}",
            name(&case)
        );
    }
}

#[test]
fn every_merge_case_merges_as_desktop_merges() {
    for case in cases("merges") {
        let local = case["local"].as_object().expect("local is an object");
        let remote = case["remote"].as_object().expect("remote is an object");
        let merged = merge_journal_fields(local, remote).expect("clocks read");
        let actual = json!({
            "tags": merged.tags,
            "properties": merged.properties,
            "fieldClocks": merged.field_clocks,
            "requeue": merged.requeue,
        });
        assert_eq!(actual, case["expected"], "{}", name(&case));
    }
}
