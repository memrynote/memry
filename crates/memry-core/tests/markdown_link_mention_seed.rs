//! The seed promotes a byte-neutral `((mention:…))` token to a `linkMention`
//! node, as Electron's `prepareFragmentSeed` does since #3871, and keeps every
//! other token as text.

#![cfg(feature = "markdown")]

use memry_core::markdown::convert::NoEmbeds;
use memry_core::markdown::convert::api::Converter;
use serde_json::{Value as Json, json};

fn seed_blocks(markdown: &str) -> Vec<Json> {
    Converter::new(Default::default())
        .prepare_seed(markdown, None, None, &NoEmbeds)
        .expect("seeds")
        .blocks
}

fn content(block: &Json) -> &Json {
    &block["content"]
}

#[test]
fn a_byte_neutral_token_becomes_one_link_mention_with_url_and_domain() {
    let blocks = seed_blocks("See ((mention:https%3A%2F%2Fwww.example.com%2Fa%5Fb)) now");
    assert_eq!(
        content(&blocks[0]),
        &json!([
            {"type": "text", "text": "See ", "styles": {}},
            {"type": "linkMention", "props": {
                "url": "https://www.example.com/a_b", "domain": "example.com",
                "title": "", "favicon": "", "siteName": ""
            }},
            {"type": "text", "text": " now", "styles": {}},
        ])
    );
}

#[test]
fn a_token_with_a_raw_underscore_stays_text() {
    let markdown = "See ((mention:https%3A%2F%2Fexample.com%2Fa_b))";
    let blocks = seed_blocks(markdown);
    let text = serde_json::to_string(content(&blocks[0])).expect("json");
    assert!(!text.contains("linkMention"), "{text}");
    assert!(
        text.contains("((mention:https%3A%2F%2Fexample.com%2Fa_b))"),
        "{text}"
    );
}

#[test]
fn a_code_block_keeps_its_token_as_text_and_a_table_cell_promotes() {
    let token = "((mention:https%3A%2F%2Fexample.com))";
    let code = seed_blocks(&format!("```\n{token}\n```"));
    assert!(!code[0].to_string().contains("linkMention"), "{}", code[0]);

    let table = seed_blocks(&format!("| a |\n| - |\n| {token} |"));
    assert!(table[0].to_string().contains("linkMention"), "{}", table[0]);
}
