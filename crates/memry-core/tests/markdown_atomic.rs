//! A converter call either succeeds or leaves the live document exactly as it
//! was (#3522 review): a failing `replace_body` or `seed_body` must not wipe or
//! half-write the body.

#![cfg(feature = "markdown")]

mod support;

use memry_core::markdown::convert::NoEmbeds;
use memry_core::markdown::convert::api::ReplaceOptions;
use memry_core::markdown::convert::apply::ReplaceOutcome;
use support::doc_case::{FRAGMENT, converter_for, fragment_text, open_document};

/// A table whose cell spans more rows than the table has: the TypeScript
/// answers `null` for it (the block builder throws), so the Rust must fail.
const FAILING: &str = "<table><tr><td rowspan=\"50\">x</td></tr></table>";

fn state(doc: &memry_core::crdt::registry::Document) -> (Vec<u8>, Vec<u8>) {
    (
        doc.encode_state().expect("state"),
        doc.state_vector().expect("sv"),
    )
}

#[test]
fn a_failing_replace_leaves_the_body_alone() {
    let converter = converter_for(&serde_json::json!({}));
    let doc = open_document();
    assert!(converter.seed_body(&doc, "keep me\n\nand me", None, None, &NoEmbeds));
    let before = state(&doc);
    let text = fragment_text(&doc);
    let outcome = converter.replace_body(&doc, FAILING, ReplaceOptions::default());
    assert_eq!(outcome, ReplaceOutcome::Failed);
    assert_eq!(state(&doc), before);
    assert_eq!(fragment_text(&doc), text);
    assert!(text.contains("keep me"), "{text}");
    let _ = FRAGMENT;
}

#[test]
fn a_failing_seed_leaves_the_document_empty() {
    let converter = converter_for(&serde_json::json!({}));
    let doc = open_document();
    let before = state(&doc);
    assert!(!converter.seed_body(&doc, FAILING, None, None, &NoEmbeds));
    assert_eq!(state(&doc), before);
}
