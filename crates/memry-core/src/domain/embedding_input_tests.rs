//! Reproduces `packages/contracts/test-vectors/embedding-input.json`, which Electron's
//! `embedding-input.ts` generates (`apps/desktop/scripts/embedding-input-oracle/`).

use super::*;
use serde_json::Value;

fn vectors() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/contracts/test-vectors/embedding-input.json"
    );
    serde_json::from_str(&std::fs::read_to_string(path).expect("embedding-input.json"))
        .expect("json")
}

fn text(value: &Value) -> Option<&str> {
    value.as_str()
}

#[test]
fn constants_match_the_oracle() {
    let file = vectors();
    let c = &file["constants"];
    let expected = [
        ("maxEmbeddingInputLength", MAX_EMBEDDING_INPUT_LENGTH),
        ("maxEmbeddingChunks", MAX_EMBEDDING_CHUNKS),
        ("maxEmbeddableContentLength", MAX_EMBEDDABLE_CONTENT_LENGTH),
        ("maxInterleavedTextLength", MAX_INTERLEAVED_TEXT_LENGTH),
        ("embeddingInputVersion", EMBEDDING_INPUT_VERSION as usize),
        (
            "imageEmbeddingInputVersion",
            IMAGE_EMBEDDING_INPUT_VERSION as usize,
        ),
    ];
    for (key, value) in expected {
        assert_eq!(c[key].as_u64(), Some(value as u64), "{key}");
    }
}

#[test]
fn every_case_matches_the_oracle() {
    let file = vectors();
    let cases = file["cases"].as_array().expect("cases");
    assert_eq!(cases.len(), 61);
    assert_eq!(file["meta"]["caseCount"].as_u64(), Some(61));
    for case in cases {
        let name = case["name"].as_str().expect("name");
        let want = &case["expected"];
        match case["kind"].as_str().expect("kind") {
            "note" => {
                let (title, content) = (text(&case["title"]), text(&case["content"]));
                assert_eq!(
                    build_embedding_input(title, content, EmbeddingTask::Document),
                    want["document"].as_str().expect("document"),
                    "{name}: document"
                );
                assert_eq!(
                    build_embedding_input(title, content, EmbeddingTask::Similarity),
                    want["similarity"].as_str().expect("similarity"),
                    "{name}: similarity"
                );
                let chunks: Vec<&str> = want["chunks"]
                    .as_array()
                    .expect("chunks")
                    .iter()
                    .map(|c| c.as_str().expect("chunk"))
                    .collect();
                assert_eq!(
                    build_embedding_chunks(title, content),
                    chunks,
                    "{name}: chunks"
                );
            }
            "query" => assert_eq!(
                build_query_embedding_input(case["query"].as_str().expect("query")),
                want["query"].as_str().expect("query"),
                "{name}: query"
            ),
            "interleaved" => assert_eq!(
                build_interleaved_input(text(&case["text"])).as_deref(),
                text(&want["interleaved"]),
                "{name}: interleaved"
            ),
            other => panic!("{name}: unknown kind {other}"),
        }
    }
}

/// `String.prototype.trim` strips U+FEFF and keeps U+0085; Rust's `trim` does the opposite.
#[test]
fn trim_is_javascripts() {
    let units: Vec<u16> = "\u{feff}\u{85}a\u{85}\u{feff}".encode_utf16().collect();
    assert_eq!(String::from_utf16_lossy(js_trim(&units)), "\u{85}a\u{85}");
}
