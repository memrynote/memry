//! The `text-extract` committed vector class, chapter 12 §12.1 and §12.11.
//!
//! This class is the contract between two `extract_text` ports, which is what
//! lets SC-010 compare a digest across shells at all: `title + "\n" +
//! extract_text(doc)` can only differ on content once both extractors are
//! pinned to the same bytes. So every case is asserted **byte for byte**, and
//! the `meta` block is asserted against the crate's own constants — a constant
//! that moves under the chapter has to be a red build, not a review note
//! (FR-008, rule 3 of `packages/contracts/test-vectors/README.md`).
//!
//! Its own file rather than a seventh class in `tests/vectors.rs`, for the same
//! reason `crdt_vectors.rs` is: this one needs the document registry, and the
//! others need none of it. The harness rule is unchanged — the committed JSON
//! is the only input and nothing here recomputes an expectation.

mod support;

use std::sync::Arc;

use memry_core::crdt::registry::UpdateSink;
use memry_core::crdt::{BODY_FRAGMENT, DocumentRegistry, extract_text};
use support::{hex_field, str_field, vector_file};

/// Every case's document goes through the registry, which is the only door
/// chapter 12 §12.5.1 allows: a full-state update in, a read transaction out,
/// and no rebuilding through named accessors anywhere.
fn extracted(case_name: &str, update: &[u8]) -> String {
    let sink: UpdateSink = Arc::new(|_, _| {});
    let registry = DocumentRegistry::new("device-vectors", sink);
    let document = registry
        .get_or_open("abc123def456")
        .unwrap_or_else(|error| panic!("{case_name}: open: {error}"));
    document
        .apply_durable_update(update)
        .unwrap_or_else(|error| panic!("{case_name}: apply: {error}"));
    extract_text(&document).unwrap_or_else(|error| panic!("{case_name}: extract: {error}"))
}

#[test]
fn text_extract_meta_matches_the_crate_constants() {
    let vectors = vector_file("text-extract");
    let meta = &vectors["meta"];

    assert_eq!(meta["class"].as_str(), Some("text-extract"));
    assert_eq!(
        meta["fragmentName"].as_str(),
        Some(BODY_FRAGMENT),
        "the body fragment's name is chapter 12 §12.3's, shared with \
         CRDT_FRAGMENT_NAME and BRIDGE_FRAGMENT_NAME"
    );
    assert_eq!(
        meta["caseCount"].as_u64(),
        Some(vectors["cases"].as_array().expect("cases").len() as u64)
    );
}

#[test]
fn text_extract_vectors() {
    let vectors = vector_file("text-extract");
    let cases = vectors["cases"].as_array().expect("cases");
    assert_eq!(cases.len(), 12, "the committed class carries twelve cases");

    for case in cases {
        let name = str_field(case, "name");
        let expected = str_field(case, "expectedText");
        let update = hex_field(case, "updateHex");

        let actual = extracted(name, &update);

        assert_eq!(
            actual.as_bytes(),
            expected.as_bytes(),
            "{name}: {}\n  expected {expected:?}\n  actual   {actual:?}",
            str_field(case, "pins")
        );
    }
}

/// The negative control the README asks for: without heading and list markers
/// the class still has to fail, or the byte-for-byte assertion above is
/// asserting nothing that a bare text dump would not also pass.
#[test]
fn a_marker_dropping_extractor_would_fail_this_class() {
    let vectors = vector_file("text-extract");
    let cases = vectors["cases"].as_array().expect("cases");

    let marked = cases
        .iter()
        .filter(|case| {
            let expected = str_field(case, "expectedText");
            expected.lines().any(|line| {
                line.starts_with("# ") || line.starts_with("- ") || line.starts_with("1. ")
            })
        })
        .count();

    assert!(
        marked >= 3,
        "at least three cases must carry a marker, or dropping every marker \
         would still pass the class"
    );
}
