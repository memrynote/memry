//! `inbox.json` (spec 006 IB014) through the conformance seam: every apply
//! sequence ends on the row desktop holds, and the list and stats reads answer
//! desktop's numbers for the same rows.

use memry_core::api::inbox_conformance::inbox_conformance;
use serde_json::Value;

fn vector() -> (String, Value) {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/contracts/test-vectors/inbox.json"
    );
    let text = std::fs::read_to_string(path).expect("inbox.json");
    let value = serde_json::from_str(&text).expect("inbox.json is JSON");
    (text, value)
}

#[test]
fn every_apply_sequence_ends_on_desktops_row() {
    let (text, file) = vector();
    let out: Value = serde_json::from_str(&inbox_conformance(text)).expect("seam answers JSON");
    let expected = file["apply"].as_array().expect("apply cases");
    let actual = out["apply"].as_array().expect("apply results");
    assert_eq!(expected.len(), actual.len());
    for (want, got) in expected.iter().zip(actual) {
        assert!(
            got.get("error").is_none(),
            "{}: {}",
            want["name"],
            got["error"]
        );
        assert_eq!(got["actual"], want["expected"], "{}", want["name"]);
    }
}

#[test]
fn the_views_answer_desktops_numbers() {
    let (text, file) = vector();
    let out: Value = serde_json::from_str(&inbox_conformance(text)).expect("seam answers JSON");
    assert_eq!(out["views"], file["views"]["expected"]);
}
