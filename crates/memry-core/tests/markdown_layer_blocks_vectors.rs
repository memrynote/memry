//! `markdown-convert/layer-blocks.json`: the editor-schema block layers
//! (callout types, `blocks/markdown.ts`, quote, columns) and the shared YouTube
//! id extraction, as function-level cases. The oracle's async parse/serialize
//! callbacks are the stub pair of `stubs.rs`.

#![cfg(feature = "markdown")]

mod support;

#[path = "markdown_layer_blocks_vectors/dispatch.rs"]
mod dispatch;
#[path = "markdown_layer_blocks_vectors/scan.rs"]
mod scan;
#[path = "markdown_layer_blocks_vectors/stubs.rs"]
mod stubs;

use std::collections::BTreeMap;

use support::vector_compare::{Failures, json_equal};
use support::vector_file;

#[test]
fn layer_blocks_vectors() {
    let vectors = vector_file("markdown-convert/layer-blocks");
    let mut failures = Failures::default();
    let mut per_group: BTreeMap<String, usize> = BTreeMap::new();
    let mut functions: BTreeMap<String, usize> = BTreeMap::new();
    for case in vectors["cases"].as_array().expect("cases") {
        let id = case["id"].as_str().expect("id");
        assert_eq!(case["op"], "fn", "{id}");
        let name = case["input"]["fn"].as_str().expect("fn");
        let args = case["input"]["args"].as_array().expect("args");
        *per_group
            .entry(id.split('/').next().unwrap_or("").to_owned())
            .or_default() += 1;
        *functions.entry(name.to_owned()).or_default() += 1;

        let actual = dispatch::run(name, args);
        let expected = &case["expected"];
        let outcome = match (expected["status"].as_str(), actual) {
            (_, Err(e)) if e.starts_with("no Rust dispatch") => Err(e),
            (Some("ok"), Ok(output)) => json_equal(
                expected.get("output").unwrap_or(&serde_json::Value::Null),
                &output,
            ),
            (Some("ok"), Err(e)) => Err(format!("failed: {e}")),
            (Some("error"), Ok(_)) => Err("the oracle threw, the port did not".into()),
            (Some("error"), Err(_)) => Ok(()),
            _ => Err("unknown status".into()),
        };
        failures.check(id, outcome);
    }
    println!(
        "layer-blocks: {} cases, by group {per_group:?}",
        failures.checked()
    );
    println!("layer-blocks: {} functions", functions.len());
    failures.finish("markdown-convert/layer-blocks");
}
