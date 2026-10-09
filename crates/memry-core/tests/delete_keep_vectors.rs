//! The `delete-keep` conformance class (#3029, chapter 05 §5.8 client
//! behavior): whether a pulled delete keeps local text the deleter cannot
//! have seen. The committed JSON is the only input, and nothing here
//! recomputes an expectation.

mod support;

use memry_core::sync::clock::VectorClock;
use memry_core::sync::delete_keep::{
    DELETE_KEEP_SKEW_MS, UnseenTextFacts, deleted_at_ms, keeps_unseen_text,
};
use serde_json::Value as Json;
use support::vector_file;

fn clock(value: &Json) -> Option<VectorClock> {
    (!value.is_null())
        .then(|| serde_json::from_value(value.clone()).expect("a vector clock or null"))
}

#[test]
fn delete_keep_cases_match_the_committed_vectors() {
    let file = vector_file("delete-keep");
    let cases = file["cases"].as_array().expect("cases is an array");
    assert_eq!(
        cases.len() as u64,
        file["meta"]["caseCount"].as_u64().expect("a case count")
    );
    assert_eq!(file["skewMs"].as_i64(), Some(DELETE_KEEP_SKEW_MS));

    for case in cases {
        let name = case["name"].as_str().expect("every case is named");
        let f = &case["facts"];
        let facts = UnseenTextFacts {
            body_blank: f["bodyBlank"].as_bool().expect("bodyBlank"),
            waiting_changes: f["waitingChanges"].as_bool().expect("waitingChanges"),
            local_clock: clock(&f["localClock"]),
            tombstone_clock: clock(&f["tombstoneClock"]),
            deleted_at: f["deletedAt"].as_i64(),
            last_local_body_at: f["lastLocalBodyAt"].as_i64(),
        };
        assert_eq!(
            Some(keeps_unseen_text(&facts)),
            case["expected"]["keep"].as_bool(),
            "{name}: keep"
        );
        assert_eq!(
            facts.deleted_at.map(deleted_at_ms),
            case["expected"]["deletedAtMs"].as_i64(),
            "{name}: deletedAtMs"
        );
    }
}
