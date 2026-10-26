//! The `markdown-convert/html-to-blocks.json` and `parse.json` conformance
//! files: BlockNote's HTML parse (nested lists, whitespace, the ProseMirror
//! `DOMParser` with the memry rules, `nodeToBlock`) and its markdown parse,
//! as canonical block JSON.

#![cfg(feature = "markdown")]

mod support;

use memry_core::markdown::bn::html_to_blocks::{html_to_blocks, markdown_to_blocks};
use serde_json::Value as Json;
use support::vector_compare::{Failures, json_equal};
use support::vector_file;

fn run(file: &str, input_key: &str, convert: fn(&str) -> Result<Json, String>) {
    let vectors = vector_file(file);
    let mut failures = Failures::default();
    for case in vectors["cases"].as_array().expect("cases") {
        let id = case["id"].as_str().expect("id");
        let input = case["input"][input_key].as_str().expect("input");
        let expected = &case["expected"];
        let actual = convert(input);
        let outcome = match (expected["status"].as_str(), actual) {
            (Some("ok"), Ok(blocks)) => {
                // parse.json wraps the blocks beside `memryLayerNoop`.
                let want = expected["output"]
                    .get("blocks")
                    .unwrap_or(&expected["output"]);
                json_equal(want, &blocks)
            }
            (Some("ok"), Err(e)) => Err(format!("failed: {e}")),
            (Some("error"), Ok(_)) => Err("the oracle threw, the port did not".into()),
            (Some("error"), Err(_)) => Ok(()),
            _ => Err("unknown status".into()),
        };
        failures.check(id, outcome);
    }
    println!("{file}: {} cases", failures.checked());
    failures.finish(file);
}

#[test]
fn html_to_blocks_vectors() {
    run("markdown-convert/html-to-blocks", "html", |h| {
        html_to_blocks(h).map_err(|e| e.to_string())
    });
}

#[test]
fn bn_parse_vectors() {
    run("markdown-convert/parse", "markdown", |m| {
        markdown_to_blocks(m).map_err(|e| e.to_string())
    });
}
