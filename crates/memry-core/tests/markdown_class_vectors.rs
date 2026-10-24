//! The `markdown-convert/markdown-class.json` conformance file: the note and
//! large-file classes of `packages/shared/src/markdown-class.ts`.

#![cfg(feature = "markdown")]

mod support;

use memry_core::markdown::shared::markdown_class::{
    LargeFileReason, MarkdownClassThresholds, classify_markdown_content,
};
use serde_json::Value as Json;
use support::vector_file;

#[test]
fn every_class_case_matches_the_oracle() {
    let file = vector_file("markdown-convert/markdown-class");
    let cases = file["cases"].as_array().expect("cases");
    assert_eq!(file["meta"]["caseCount"].as_u64(), Some(cases.len() as u64));
    for case in cases {
        let id = case["id"].as_str().expect("id");
        let input = &case["input"];
        let defaults = MarkdownClassThresholds::default();
        let thresholds = MarkdownClassThresholds {
            max_file_bytes: input["maxFileBytes"]
                .as_u64()
                .map_or(defaults.max_file_bytes, |n| n as usize),
            max_block_bytes: input["maxBlockBytes"]
                .as_u64()
                .map_or(defaults.max_block_bytes, |n| n as usize),
        };
        let got =
            classify_markdown_content(input["markdown"].as_str().expect("markdown"), thresholds);
        let expected = &case["expected"]["output"];
        let reason = match got.large_file {
            None => Json::Null,
            Some(LargeFileReason::FileBytes) => Json::from("file-bytes"),
            Some(LargeFileReason::BlockBytes) => Json::from("block-bytes"),
        };
        assert_eq!(expected["reason"], reason, "{id}: reason");
        assert_eq!(
            expected["sizeClass"],
            if got.large_file.is_some() {
                "large-file"
            } else {
                "note"
            },
            "{id}: class"
        );
        assert_eq!(
            expected["fileBytes"].as_u64(),
            Some(got.file_bytes as u64),
            "{id}: fileBytes"
        );
        assert_eq!(
            expected["largestBlockBytes"].as_u64(),
            Some(got.largest_block_bytes as u64),
            "{id}: largestBlockBytes"
        );
    }
    println!("markdown-class vectors: {} cases", cases.len());
}
