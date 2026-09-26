//! The `recreate-clock` conformance class (#2409, chapter 05 §5.8, chapter 06
//! §6.1): a write that (re)creates an id ticks from `merge(local, tombstone)`.
//! The committed JSON is the only input — rule 2 of
//! `packages/contracts/test-vectors/README.md` — and nothing here recomputes an
//! expectation.

mod support;

use memry_core::sync::clock::{VectorClock, increment, recreate_base};
use serde_json::Value as Json;
use support::vector_file;

fn clock(value: &Json) -> Option<VectorClock> {
    (!value.is_null())
        .then(|| serde_json::from_value(value.clone()).expect("a vector clock or null"))
}

#[test]
fn recreate_clock_cases_match_the_committed_vectors() {
    let file = vector_file("recreate-clock");
    let cases = file["cases"].as_array().expect("cases is an array");
    assert_eq!(
        cases.len() as u64,
        file["meta"]["caseCount"].as_u64().expect("a case count")
    );

    for case in cases {
        let name = case["name"].as_str().expect("every case is named");
        let current = clock(&case["current"]).unwrap_or_default();
        let tombstone = clock(&case["tombstone"]);
        let is_create = match case["operation"].as_str() {
            Some("create") => true,
            Some("update") => false,
            other => panic!("{name}: unknown operation {other:?}"),
        };
        let device = case["device"].as_str().expect("a device id");

        let base = recreate_base(&current, tombstone.as_ref(), is_create);
        assert_eq!(
            Some(base.clone()),
            clock(&case["expected"]["base"]),
            "{name}: base"
        );
        assert_eq!(
            Some(increment(&base, device)),
            clock(&case["expected"]["next"]),
            "{name}: next"
        );
    }
}
