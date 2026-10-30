//! `vault::svg` against the TypeScript sanitizer (`fixtures/sanitize-svg.json`, produced by
//! `fixtures/gen-svg-vectors.mjs`): the test suite's inputs, one input per branch of the Rust
//! scanners, malformed UTF-8, and 1500 seeded token soups.
//!
//! The ported passes equal the TypeScript byte for byte. The output the app writes may differ
//! from it only by dropping parts and writing a `<` as `&lt;`, and it is inert and stable.

mod svg_inert;

use base64::Engine;
use memry_desktop::vault::svg::{sanitize_svg, sanitize_svg_as_typescript};
use serde_json::Value;
use svg_inert::{check_inert, only_drops_or_escapes};

fn input(case: &Value) -> String {
    let bytes = match (case.get("input"), case.get("inputBase64")) {
        (Some(text), _) => text.as_str().expect("input").as_bytes().to_vec(),
        (None, Some(encoded)) => base64::engine::general_purpose::STANDARD
            .decode(encoded.as_str().expect("inputBase64"))
            .expect("base64"),
        (None, None) => panic!("case without input: {case}"),
    };
    String::from_utf8_lossy(&bytes).into_owned()
}

fn assert_no_failures(what: &str, failed: &[String]) {
    assert!(
        failed.is_empty(),
        "{} cases {what}:\n{}",
        failed.len(),
        failed.join("\n")
    );
}

fn assert_typescript_passes_match(vectors: &Value) {
    let mut failed = Vec::new();
    for case in vectors["cases"].as_array().expect("cases") {
        let input = input(case);
        let expected = case["output"].as_str();
        let actual = sanitize_svg_as_typescript(&input);
        if actual.as_deref() != expected {
            failed.push(format!(
                "{}\n  input:    {input:?}\n  expected: {expected:?}\n  actual:   {actual:?}",
                case["name"]
            ));
        }
    }
    assert_no_failures("differ from the TypeScript", &failed);
}

fn assert_written_output_is_inert(vectors: &Value) {
    let mut failed = Vec::new();
    for case in vectors["cases"].as_array().expect("cases") {
        let input = input(case);
        let Some(out) = sanitize_svg(&input) else {
            continue;
        };
        let typescript = case["output"].as_str().unwrap_or("");
        let problem = check_inert(&out).err().or_else(|| {
            (sanitize_svg(&out).as_deref() != Some(out.as_str()))
                .then(|| "a second pass changes it".to_owned())
        });
        let problem = problem.or_else(|| {
            (!only_drops_or_escapes(out.as_bytes(), typescript.as_bytes()))
                .then(|| format!("not the TypeScript's {typescript:?} with parts dropped"))
        });
        if let Some(problem) = problem {
            failed.push(format!(
                "{}: {problem}\n  input:  {input:?}\n  output: {out:?}",
                case["name"]
            ));
        }
    }
    assert_no_failures("break the written output's rules", &failed);
}

fn committed_vectors() -> Value {
    let vectors: Value =
        serde_json::from_str(include_str!("fixtures/sanitize-svg.json")).expect("vector file");
    assert!(vectors["cases"].as_array().expect("cases").len() > 1600);
    vectors
}

#[test]
fn the_ported_passes_return_what_the_typescript_returned() {
    assert_typescript_passes_match(&committed_vectors());
}

#[test]
fn the_written_output_is_inert_stable_and_the_typescripts_with_parts_dropped() {
    assert_written_output_is_inert(&committed_vectors());
}

/// A larger run the generator writes outside the repo (see `gen-svg-vectors.mjs`).
#[test]
#[ignore = "reads MEMRY_SVG_VECTORS, a file a local differential run writes"]
fn a_generated_run_matches_the_typescript() {
    let path = std::env::var("MEMRY_SVG_VECTORS").expect("MEMRY_SVG_VECTORS");
    let vectors: Value =
        serde_json::from_str(&std::fs::read_to_string(path).expect("read")).expect("parse");
    assert_typescript_passes_match(&vectors);
    assert_written_output_is_inert(&vectors);
}
