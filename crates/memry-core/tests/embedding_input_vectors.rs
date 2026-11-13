//! `embedding-input.json` (`docs/protocol/15-embedding-input.md`): every note
//! and query is shaped into the text desktop's `embedding-input.ts` feeds the
//! model, byte for byte, through the conformance seam the iOS plan calls.

mod support;

use memry_core::api::embedding_input_conformance::embedding_input_conformance;
use memry_core::domain::embedding_input::{EMBEDDING_INPUT_VERSION, MAX_INPUT_UNITS, MAX_WINDOWS};
use serde_json::Value;
use support::vector_file;

fn shaped() -> (Value, Value) {
    let file = vector_file("embedding-input");
    let out = serde_json::from_str(&embedding_input_conformance(file.to_string()))
        .expect("seam answers JSON");
    (file, out)
}

#[test]
fn meta_matches_the_crate_constants() {
    let meta = &vector_file("embedding-input")["meta"];
    assert_eq!(
        meta["inputVersion"].as_u64(),
        Some(u64::from(EMBEDDING_INPUT_VERSION)),
        "desktop bumped EMBEDDING_INPUT_VERSION: review the port, then bump the crate's"
    );
    assert_eq!(meta["maxInputUnits"].as_u64(), Some(MAX_INPUT_UNITS as u64));
    assert_eq!(meta["maxWindows"].as_u64(), Some(MAX_WINDOWS as u64));
}

#[test]
fn every_note_shapes_as_desktop_does() {
    let (file, out) = shaped();
    let expected = file["cases"].as_array().expect("cases");
    let actual = out["cases"].as_array().expect("results");
    assert_eq!(expected.len(), actual.len());
    for (want, got) in expected.iter().zip(actual) {
        assert_eq!(got["name"], want["name"]);
        assert_eq!(
            got["actual"], want["expected"],
            "{}: {}",
            want["name"], want["pins"]
        );
    }
}

#[test]
fn every_query_shapes_as_desktop_does() {
    let (file, out) = shaped();
    let expected = file["queries"].as_array().expect("queries");
    let actual = out["queries"].as_array().expect("results");
    assert_eq!(expected.len(), actual.len());
    for (want, got) in expected.iter().zip(actual) {
        assert_eq!(
            got["actual"], want["expected"],
            "{}: {}",
            want["name"], want["pins"]
        );
    }
}
