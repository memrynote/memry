//! `temml.renderToString` (temml 0.13.3, MathML output, `throwOnError: false`) against
//! `temml-cases.json` (hand-written inputs) and `temml-fuzz.json` (seeded inputs), byte for byte.
//! When temml throws or renders its error span, the vector says `error` and the port returns
//! `Err`.

use std::{fs, path::PathBuf};

use memry_desktop::web::extract::elements::math::temml::render_to_string;
use serde_json::Value;

fn read(path: &str) -> Value {
    let full = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/contracts/test-vectors/article-extract")
        .join(path);
    serde_json::from_str(
        &fs::read_to_string(&full).unwrap_or_else(|e| panic!("{}: {e}", full.display())),
    )
    .unwrap()
}

fn compare(file: &str) -> usize {
    let vectors = read(file);
    let vectors = vectors.as_array().unwrap();
    let mut failures = Vec::new();
    for vector in vectors {
        let input = vector["input"].as_str().unwrap();
        let display = vector["display"].as_bool().unwrap();
        let actual = render_to_string(input, display);
        let matches = match vector["ok"].as_str() {
            Some(expected) => actual.as_deref() == Ok(expected),
            None => actual.is_err(),
        };
        if !matches {
            failures.push(format!(
                "{input:?} (display {display}):\n  rust: {actual:?}\n  node: {:?}",
                vector.get("ok").unwrap_or(&Value::String("<error>".into()))
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} differences:\n{}",
        failures.len(),
        failures.join("\n")
    );
    vectors.len()
}

#[test]
fn temml_cases_match() {
    assert!(compare("temml-cases.json") > 500);
}

#[test]
fn temml_fuzz_matches() {
    assert_eq!(compare("temml-fuzz.json"), 2000);
}
