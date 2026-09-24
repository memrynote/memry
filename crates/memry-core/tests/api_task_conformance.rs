//! The task conformance seam answers the committed vectors (spec 004 TP080):
//! what the Swift harness will compare, checked here first against the file.

mod support;

use memry_core::api::task_conformance::{task_due_windows_conformance, task_filtering_conformance};
use serde_json::Value;
use support::vector_file;

#[test]
fn due_windows_through_the_seam_match_the_file() {
    let file = vector_file("task-parsing");
    let section = &file["dueWindows"];
    let actual: Value =
        serde_json::from_str(&task_due_windows_conformance(section.to_string())).expect("json");
    assert_eq!(actual, section["at"]);
}

#[test]
fn filtering_through_the_seam_matches_the_file() {
    let file = vector_file("task-filtering");
    let actual: Value =
        serde_json::from_str(&task_filtering_conformance(file.to_string())).expect("json");
    for (name, cases) in file["dimensions"].as_object().expect("dimensions") {
        let expected: Vec<&Value> = cases
            .as_array()
            .expect("cases")
            .iter()
            .map(|c| &c["expected"])
            .collect();
        let got: Vec<&Value> = actual["dimensions"][name]
            .as_array()
            .expect("computed")
            .iter()
            .collect();
        assert_eq!(got, expected, "dimension {name}");
    }
    for section in ["sorts", "groups", "applied"] {
        let expected: Vec<&Value> = file[section]
            .as_array()
            .expect("cases")
            .iter()
            .map(|c| &c["expected"])
            .collect();
        let got: Vec<&Value> = actual[section]
            .as_array()
            .expect("computed")
            .iter()
            .collect();
        assert_eq!(got, expected, "{section}");
    }
}
