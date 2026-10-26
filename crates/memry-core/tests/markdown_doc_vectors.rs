//! The Y.Doc half of the `markdown-convert` class over the markdown inputs:
//! `seed-doc.json` (the document a seed writes), `roundtrip.json` (read back as
//! markdown, byte for byte) and `blocks.json` (the block view).

#![cfg(feature = "markdown")]

mod support;

use serde_json::Value as Json;
use support::doc_case::{
    FRAGMENT, build_document, converter_for, files_of, fragment_text, roots_json, serialized,
    sorted,
};
use support::vector_compare::{Failures, bytes_equal, json_equal};
use support::vector_file;

fn text_of(value: &Json) -> Option<&str> {
    value.as_str()
}

fn opt_bytes(expected: &Json, actual: Option<&str>) -> Result<(), String> {
    match (text_of(expected), actual) {
        (Some(want), Some(got)) => bytes_equal(want, got),
        (None, None) => Ok(()),
        (want, got) => Err(format!("expected {want:?}, got {got:?}")),
    }
}

#[test]
fn seeded_documents_match_the_oracle() {
    let file = vector_file("markdown-convert/seed-doc");
    let mut failures = Failures::default();
    for case in file["cases"].as_array().expect("cases") {
        let id = case["id"].as_str().expect("id");
        let input = &case["input"];
        let converter = converter_for(input);
        let files = files_of(input);
        let built = build_document(&converter, input, &files);
        let outcome = match (case["expected"]["status"].as_str(), built) {
            (Some("error"), Err(_)) => Ok(()),
            (Some("error"), Ok(_)) => Err("the oracle threw, the Rust seeded".to_owned()),
            (_, Err(e)) => Err(e),
            (_, Ok(document)) => {
                let want = &case["expected"]["output"];
                bytes_equal(
                    want["fragment"].as_str().unwrap_or(""),
                    &fragment_text(&document),
                )
                .map_err(|e| format!("fragment: {e}"))
                .and_then(|()| {
                    json_equal(&sorted(&want["roots"]), &sorted(&roots_json(&document)))
                        .map_err(|e| format!("roots: {e}"))
                })
            }
        };
        failures.check(id, outcome);
    }
    println!("seed-doc: {} cases", failures.checked());
    failures.finish("seed-doc.json");
}

#[test]
fn read_back_markdown_matches_the_oracle_byte_for_byte() {
    let file = vector_file("markdown-convert/roundtrip");
    let mut failures = Failures::default();
    for case in file["cases"].as_array().expect("cases") {
        let id = case["id"].as_str().expect("id");
        let input = &case["input"];
        let converter = converter_for(input);
        let files = files_of(input);
        let built = build_document(&converter, input, &files);
        let outcome = match (case["expected"]["status"].as_str(), built) {
            (Some("error"), Err(_)) => Ok(()),
            (Some("error"), Ok(_)) => Err("the oracle threw, the Rust seeded".to_owned()),
            (_, Err(e)) => Err(e),
            (_, Ok(document)) => {
                let want = &case["expected"]["output"];
                let got = serialized(&converter, &document, input, &files);
                opt_bytes(&want["markdown"], got["markdown"].as_str())
                    .map_err(|e| format!("markdown: {e}"))
                    .and_then(|()| {
                        json_equal(&want["outcome"], &got["outcome"])
                            .map_err(|e| format!("outcome: {e}"))
                    })
                    .and_then(|()| {
                        opt_bytes(&want["canonical"], got["canonical"].as_str())
                            .map_err(|e| format!("canonical: {e}"))
                    })
                    .and_then(|()| {
                        let (w, g) = (&want["noteBody"], &got["noteBody"]);
                        opt_bytes(&w["markdown"], g["markdown"].as_str())
                            .map_err(|e| format!("note body: {e}"))
                            .and_then(|()| {
                                json_equal(&sorted(&w["writing"]), &sorted(&g["writing"]))
                                    .map_err(|e| format!("writing frontmatter: {e}"))
                            })
                            .and_then(|()| {
                                json_equal(&w["outcome"], &g["outcome"])
                                    .map_err(|e| format!("note outcome: {e}"))
                            })
                    })
                    .and_then(|()| {
                        json_equal(&want["unrepresentable"], &got["unrepresentable"])
                            .map_err(|e| format!("unrepresentable: {e}"))
                    })
            }
        };
        failures.check(id, outcome);
    }
    println!("roundtrip: {} cases", failures.checked());
    failures.finish("roundtrip.json");
}

#[test]
fn the_block_view_matches_the_oracle() {
    let file = vector_file("markdown-convert/blocks");
    let mut failures = Failures::default();
    for case in file["cases"].as_array().expect("cases") {
        let id = case["id"].as_str().expect("id");
        let input = &case["input"];
        let converter = converter_for(input);
        let files = files_of(input);
        let built = build_document(&converter, input, &files);
        let fragment = input["fragment"].as_str().unwrap_or(FRAGMENT);
        let outcome = match (case["expected"]["status"].as_str(), built) {
            (Some("error"), Err(_)) => Ok(()),
            (Some("error"), Ok(_)) => Err("the oracle threw, the Rust built a doc".to_owned()),
            (_, Err(e)) => Err(e),
            (_, Ok(document)) => {
                let got = converter
                    .blocks(&document, fragment)
                    .map_or(Json::Null, Json::Array);
                json_equal(
                    &sorted(&case["expected"]["output"]["blocks"]),
                    &sorted(&got),
                )
            }
        };
        failures.check(id, outcome);
    }
    println!("blocks: {} cases", failures.checked());
    failures.finish("blocks.json");
}
