//! The block walk, held to the text walk it must never disagree with.
//!
//! `extract_text` is pinned byte-for-byte to the committed `text-extract`
//! class, because SC-010's cross-shell digest is only meaningful once both
//! ports agree. `extract_blocks` is a second, richer walk of the same
//! fragment, and a second walk is exactly how two readings of one document
//! drift apart: a block type one knows and the other does not is silent until
//! a user's note renders with a paragraph missing.
//!
//! So the guarantee is asserted rather than assumed. For every committed case,
//! rendering the blocks the way `extract_text` renders the document has to
//! produce the same bytes. The inputs are the class's own; nothing here
//! recomputes an expectation.

mod support;

use std::sync::Arc;

use memry_core::crdt::blocks::{Block, blocks_to_text, extract_blocks};
use memry_core::crdt::registry::UpdateSink;
use memry_core::crdt::{DocumentRegistry, extract_text};
use support::{hex_field, str_field, vector_file};

/// Both walks over one document, through the registry — the only door chapter
/// 12 §12.5.1 allows.
fn walks(case_name: &str, update: &[u8]) -> (String, Vec<Block>) {
    let sink: UpdateSink = Arc::new(|_, _| {});
    let registry = DocumentRegistry::new("device-vectors", sink);
    let document = registry
        .get_or_open("abc123def456")
        .unwrap_or_else(|error| panic!("{case_name}: open: {error}"));
    document
        .apply_durable_update(update)
        .unwrap_or_else(|error| panic!("{case_name}: apply: {error}"));
    let text =
        extract_text(&document).unwrap_or_else(|error| panic!("{case_name}: extract: {error}"));
    let blocks =
        extract_blocks(&document).unwrap_or_else(|error| panic!("{case_name}: blocks: {error}"));
    (text, blocks)
}

#[test]
fn blocks_render_to_the_same_text_as_extract_text() {
    let vectors = vector_file("text-extract");
    let cases = vectors["cases"].as_array().expect("cases");
    assert!(!cases.is_empty(), "the class must not be empty");

    for case in cases {
        let name = str_field(case, "name");
        let update = hex_field(case, "updateHex");
        let (text, blocks) = walks(name, &update);
        let rendered = blocks_to_text(&blocks);

        assert_eq!(
            rendered.as_bytes(),
            text.as_bytes(),
            "{name}: the two walks disagree\n  text   {text:?}\n  blocks {rendered:?}"
        );
    }
}

/// The negative control: a walk that dropped every block would pass the
/// assertion above on an empty document and on nothing else, so at least one
/// committed case has to produce blocks.
#[test]
fn the_class_exercises_real_blocks() {
    let vectors = vector_file("text-extract");
    let cases = vectors["cases"].as_array().expect("cases");

    let mut kinds: Vec<String> = Vec::new();
    for case in cases {
        let update = hex_field(case, "updateHex");
        let (_, blocks) = walks(str_field(case, "name"), &update);
        kinds.extend(blocks.iter().map(|block| block.kind.clone()));
    }
    kinds.sort();
    kinds.dedup();

    assert!(
        kinds.iter().any(|kind| kind == "paragraph"),
        "no case produced a paragraph; the walk is not reaching the body"
    );
    assert!(
        kinds.len() > 1,
        "every block came out as one kind ({kinds:?}), which no real note is"
    );
}

/// What the text walk drops and this one must not: a heading's level survives
/// as a property rather than as a `#` the shell would have to parse back.
#[test]
fn a_heading_keeps_its_level_as_a_property() {
    let vectors = vector_file("text-extract");
    let cases = vectors["cases"].as_array().expect("cases");

    let mut seen_heading = false;
    for case in cases {
        let update = hex_field(case, "updateHex");
        let (_, blocks) = walks(str_field(case, "name"), &update);
        for block in blocks.iter().filter(|block| block.kind == "heading") {
            seen_heading = true;
            assert!(
                block.props.iter().any(|prop| prop.name == "level"),
                "a heading crossed without its level: {:?}",
                block.props
            );
        }
    }
    assert!(seen_heading, "the class carries no heading to check");
}
