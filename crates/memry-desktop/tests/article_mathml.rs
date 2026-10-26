//! `MathMLToLaTeX.convert` (mathml-to-latex 1.8.0 on xmldom 0.8.15) against
//! `mathml-cases.json` (hand-written inputs for every converter and xmldom recovery) and
//! `mathml-fuzz.json` (1000 seeded inputs), byte for byte. A thrown error in JS is an `Err` here.

use std::{fs, path::PathBuf};

use memry_desktop::web::extract::elements::math::convert::mathml_to_latex;
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
        let actual = mathml_to_latex(input);
        let matches = match vector["ok"].as_str() {
            Some(expected) => actual.as_deref() == Ok(expected),
            None => actual.is_err(),
        };
        if !matches {
            failures.push(format!(
                "{input:?}:\n  rust: {actual:?}\n  node: {:?}",
                vector.get("ok").or_else(|| vector.get("error"))
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
fn mathml_cases_match() {
    assert!(compare("mathml-cases.json") > 250);
}

#[test]
fn mathml_fuzz_matches() {
    assert_eq!(compare("mathml-fuzz.json"), 1000);
}
