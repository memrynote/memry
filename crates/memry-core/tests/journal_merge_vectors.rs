//! The `journal-merge` class (chapter 06 §6.12, #5508): every case of
//! `journal-merge.json` and of `journal-merge-sim.json`, the fleet
//! simulator's calls, against `sync::journal_merge`. The committed JSON is
//! the only input.

use crate::support;

use memry_core::sync::journal_merge::{
    field_clocks_for_edit, field_clocks_for_wholesale, merge_journal_fields,
};
use serde_json::{Value as Json, json};
use support::vector_file;

const FILES: [&str; 2] = ["journal-merge", "journal-merge-sim"];

fn cases(file: &str, section: &str) -> Vec<Json> {
    vector_file(file)
        .get(section)
        .and_then(Json::as_array)
        .cloned()
        .unwrap_or_default()
}

fn name(case: &Json) -> &str {
    case["name"].as_str().expect("every case is named")
}

#[test]
fn the_case_count_is_the_recorded_one() {
    for file in FILES {
        let total = cases(file, "edits").len()
            + cases(file, "wholesales").len()
            + cases(file, "merges").len();
        assert!(total > 0, "{file}.json has no cases");
        assert_eq!(
            total as u64,
            vector_file(file)["meta"]["caseCount"],
            "{file}"
        );
    }
}

#[test]
fn every_edit_case_clocks_the_units_desktop_clocks() {
    for file in FILES {
        for case in cases(file, "edits") {
            let base = case["base"].as_object();
            let next = case["next"].as_object().expect("next is an object");
            let clocks = field_clocks_for_edit(base, next).expect("clocks read");
            assert_eq!(json!(clocks), case["expected"], "{file} {}", name(&case));
        }
    }
}

#[test]
fn every_wholesale_case_keeps_the_unit_clocks_desktop_keeps() {
    for file in FILES {
        for case in cases(file, "wholesales") {
            let remote = case["remote"].as_object().expect("remote is an object");
            let clocks = field_clocks_for_wholesale(remote).expect("clocks read");
            assert_eq!(json!(clocks), case["expected"], "{file} {}", name(&case));
        }
    }
}

#[test]
fn every_merge_case_merges_as_desktop_merges() {
    for file in FILES {
        for case in cases(file, "merges") {
            let local = case["local"].as_object().expect("local is an object");
            let remote = case["remote"].as_object().expect("remote is an object");
            let device = case["device"]
                .as_str()
                .expect("every merge names its device");
            let merged = merge_journal_fields(local, remote, device).expect("clocks read");
            let mut actual = json!({
                "tags": merged.tags,
                "properties": merged.properties,
                "clock": merged.clock,
                "requeue": merged.requeue,
            });
            actual
                .as_object_mut()
                .expect("an object")
                .extend(merged.stamp);
            assert_eq!(actual, case["expected"], "{file} {}", name(&case));
        }
    }
}
