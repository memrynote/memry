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
use memry_core::crdt::text_extract::cross_shell_digest;
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
/// Chapter 12 §12.11's digest, pinned against the class that pins its input.
///
/// The vectors carry no title — §12.11 is explicit that `text-extract.json`
/// holds the two ports to the same **text** and the digest is defined on top of
/// that. So this asserts the formula: for every committed case, the digest over
/// a fixed title equals SHA-256 of `title + "\n" + expectedText`, computed
/// independently here rather than by calling the function under test.
///
/// The separator and the absence of a trailing newline are the whole point. A
/// shell that hashed `notes text`'s printed output would include the trailing
/// `\n` that `println!` adds and mismatch a shell that hashed the bytes, and
/// SC-010 would report a content difference between two shells that agree.
#[test]
fn the_cross_shell_digest_is_sha256_of_title_newline_text() {
    use sha2::{Digest as _, Sha256};

    const TITLE: &str = "A note";
    let vectors = vector_file("text-extract");
    let cases = vectors["cases"].as_array().expect("cases");
    assert!(!cases.is_empty(), "the class must not be empty");

    for case in cases {
        let name = str_field(case, "name");
        let expected_text = str_field(case, "expectedText");
        let update = hex_field(case, "updateHex");
        let extracted = extracted(name, &update);
        assert_eq!(extracted, expected_text, "{name}: the class's own claim");

        let mut independent = Sha256::new();
        independent.update(TITLE.as_bytes());
        independent.update(b"\n");
        independent.update(expected_text.as_bytes());
        let expected: [u8; 32] = independent.finalize().into();

        assert_eq!(
            cross_shell_digest(TITLE, &extracted),
            expected,
            "{name}: the digest must be SHA-256 over title + \"\\n\" + text"
        );

        // The trailing-newline trap, asserted rather than described: a shell
        // that digested the printed form gets a different value.
        let printed = format!("{extracted}\n");
        assert_ne!(
            cross_shell_digest(TITLE, &printed),
            expected,
            "{name}: a trailing newline must change the digest, or the trap is silent"
        );
    }
}

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
