//! `to_article_capture` against `mapToArticleCapture` (vectors from `packages/article-extract`).

use std::{fs, path::PathBuf};

use memry_desktop::web::extract::map::{DefuddleResult, to_article_capture};
use serde_json::Value;

#[test]
fn mapping_matches_map_to_article_capture() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/contracts/test-vectors/article-extract/map.json");
    let cases: Vec<Value> = serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
    assert!(cases.len() >= 15);
    for case in cases {
        let input = &case["input"];
        let text = |key: &str| input["result"][key].as_str().map(str::to_owned);
        let result = DefuddleResult {
            content: text("content"),
            title: text("title"),
            author: text("author"),
            published: text("published"),
            description: text("description"),
            image: text("image"),
            word_count: input["result"]["wordCount"].as_u64(),
        };
        let got = to_article_capture(
            &result,
            input["url"].as_str().unwrap(),
            input["now"].as_str().unwrap(),
        );
        let got = serde_json::to_value(&got).unwrap();
        assert_eq!(got, case["expected"], "{}", case["name"]);
    }
}
