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

/// The SQL function every core connection registers must agree with the vectors
/// too, because queries group and compare tags through `tag_fold(...)`.
#[test]
fn tag_fold_in_sql_matches_the_committed_vectors() {
    let file = vector_file("tag-fold");
    let db = memry_core::storage::Db::open_in_memory().expect("open");
    for case in file["cases"].as_array().expect("cases is an array") {
        let name = case["name"].as_str().expect("named");
        let tag = case["input"]["tag"].as_str().expect("tag").to_owned();
        let expected = case["expected"]["fold"].as_str().expect("fold").to_owned();
        let folded: String = db
            .call_blocking(|conn| {
                conn.query_row("SELECT tag_fold(?1)", [&tag], |row| row.get(0))
                    .map_err(|error| memry_core::api::errors::StorageError::Failed {
                        what: error.to_string(),
                    })
            })
            .expect("tag_fold");
        assert_eq!(folded, expected, "{name}: SQL tag_fold");
    }
}

#[test]
fn tag_fold_in_sql_passes_non_text_through_like_the_desktop_function() {
    let db = memry_core::storage::Db::open_in_memory().expect("open");
    let (null, int, blob): (Option<String>, i64, Vec<u8>) = db
        .call_blocking(|conn| {
            conn.query_row(
                "SELECT tag_fold(NULL), tag_fold(42), tag_fold(x'00ff')",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(|error| memry_core::api::errors::StorageError::Failed {
                what: error.to_string(),
            })
        })
        .expect("tag_fold over non-text");
    assert_eq!((null, int, blob), (None, 42, vec![0, 0xFF]));
}
