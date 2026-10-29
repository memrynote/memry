//! `vault::svg` equals the TypeScript sanitizer byte for byte (`fixtures/sanitize-svg.json`,
//! produced by `fixtures/gen-svg-vectors.mjs`): the test suite's inputs, one input per branch
//! of the Rust scanners, malformed UTF-8, and 1500 seeded token soups.

use base64::Engine;
use memry_desktop::vault::svg::sanitize_svg_bytes;
use serde_json::Value;

fn input(case: &Value) -> Vec<u8> {
    match (case.get("input"), case.get("inputBase64")) {
        (Some(text), _) => text.as_str().expect("input").as_bytes().to_vec(),
        (None, Some(encoded)) => base64::engine::general_purpose::STANDARD
            .decode(encoded.as_str().expect("inputBase64"))
            .expect("base64"),
        (None, None) => panic!("case without input: {case}"),
    }
}

fn assert_cases_match(vectors: &Value) {
    let cases = vectors["cases"].as_array().expect("cases");
    let mut failed = Vec::new();
    for case in cases {
        let expected = case["output"].as_str().map(str::as_bytes);
        let actual = sanitize_svg_bytes(&input(case));
        if actual.as_deref() != expected {
            failed.push(format!(
                "{}\n  input:    {:?}\n  expected: {:?}\n  actual:   {:?}",
                case["name"],
                String::from_utf8_lossy(&input(case)),
                expected.map(String::from_utf8_lossy),
                actual.as_deref().map(String::from_utf8_lossy),
            ));
        }
    }
    assert!(
        failed.is_empty(),
        "{} cases differ:\n{}",
        failed.len(),
        failed.join("\n")
    );
}

#[test]
fn every_case_sanitizes_to_what_the_typescript_returned() {
    let vectors: Value =
        serde_json::from_str(include_str!("fixtures/sanitize-svg.json")).expect("vector file");
    assert!(vectors["cases"].as_array().expect("cases").len() > 1600);
    assert_cases_match(&vectors);
}

/// A larger run the generator writes outside the repo (see `gen-svg-vectors.mjs`).
#[test]
#[ignore = "reads MEMRY_SVG_VECTORS, a file a local differential run writes"]
fn a_generated_run_matches_the_typescript() {
    let path = std::env::var("MEMRY_SVG_VECTORS").expect("MEMRY_SVG_VECTORS");
    let vectors: Value =
        serde_json::from_str(&std::fs::read_to_string(path).expect("read")).expect("parse");
    assert_cases_match(&vectors);
}
