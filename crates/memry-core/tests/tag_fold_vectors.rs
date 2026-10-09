//! Conformance for `tag-fold.json` (chapter 13 §13.7.7, tag identity).
mod support;

use memry_core::domain::tags::{fold, tag_key};
use serde_json::Value;
use support::vector_file;

#[test]
fn tag_fold_matches_the_committed_vectors() {
    let file = vector_file("tag-fold");
    let cases = file["cases"].as_array().expect("cases is an array");
    assert_eq!(
        cases.len() as u64,
        file["meta"]["caseCount"].as_u64().expect("a case count")
    );
    let strings = |value: &Value| -> Vec<String> {
        value
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .map(|s| s.as_str().expect("string").to_owned())
                    .collect()
            })
            .unwrap_or_default()
    };
    for case in cases {
        let name = case["name"].as_str().expect("named");
        let input = &case["input"];
        let tag = input["tag"].as_str().expect("tag");
        let expected = case["expected"]["fold"].as_str().expect("fold");
        assert_eq!(fold(tag), expected, "{name}: fold");
        assert_eq!(
            tag_key(tag),
            case["expected"]["key"].as_str().expect("key"),
            "{name}: key"
        );
        assert_eq!(fold(expected), expected, "{name}: idempotent");
        assert_eq!(fold(&tag.to_lowercase()), expected, "{name}: lowercase");
        for equal in strings(&input["equal"]) {
            assert_eq!(fold(&equal), expected, "{name}: {equal} is one tag");
        }
        for distinct in strings(&input["distinct"]) {
            assert_ne!(
                fold(&distinct),
                expected,
                "{name}: {distinct} is another tag"
            );
        }
    }
}
