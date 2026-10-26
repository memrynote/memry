//! `seed-corpus.json`: the bodies of a synthetic vault (the bulk generator of
//! `seed-bench-vault.ts`) through seed and read-back, against the Electron
//! converter. The file states a result only where it differs from the input; an
//! absent `markdown` or `canonical` means "the input, unchanged".

#![cfg(feature = "markdown")]

mod support;

use support::doc_case::roundtrip_of;
use support::vector_compare::{Failures, bytes_equal};
use support::vector_file;

#[test]
fn the_synthetic_vault_converts_like_the_oracle() {
    check_file("seed-corpus");
}

/// One positive and one negative note per grammar rule of protocol 12.6 to 12.8.
#[test]
fn every_grammar_rule_converts_like_the_oracle() {
    check_file("grammar-corpus");
}

fn check_file(name: &str) {
    let file = vector_file(&format!("markdown-convert/{name}"));
    let mut failures = Failures::default();
    for case in file["cases"].as_array().expect("cases") {
        let id = case["id"].as_str().expect("id");
        let markdown = case["input"]["markdown"].as_str().expect("markdown");
        let want = &case["expected"]["output"];
        let outcome = (|| {
            if case["expected"]["status"] != "ok" {
                return match roundtrip_of(markdown) {
                    Err(_) => Ok(()),
                    Ok(_) => Err("the oracle failed closed, the Rust did not".to_owned()),
                };
            }
            let got = roundtrip_of(markdown)?;
            for key in ["markdown", "canonical"] {
                let expected = want[key].as_str().unwrap_or(markdown);
                let actual = got[key].as_str().ok_or(format!("{key}: failed closed"))?;
                bytes_equal(expected, actual).map_err(|e| format!("{key}: {e}"))?;
            }
            (want["outcome"] == got["outcome"])
                .then_some(())
                .ok_or_else(|| format!("outcome {} vs {}", got["outcome"], want["outcome"]))
        })();
        failures.check(id, outcome);
    }
    println!("{name}: {} cases", failures.checked());
    failures.finish(&format!("{name}.json"));
}
