//! The `markdown-seed` conformance class (spec 005-journal JP022a).
//!
//! Each case is template markdown and the canonical `prosemirror` fragment
//! desktop's `markdownToYFragment` builds from it (proven by
//! `apps/desktop/src/main/sync/markdown-seed-vectors.test.ts`). The core's
//! seed must build the same document. Block ids are random on both sides, so
//! both renderings drop the `id` of every `blockContainer`.

mod support;

use std::sync::Arc;

use memry_core::crdt::blocks::extract_blocks;
use memry_core::crdt::canonical::canonical_fragment;
use memry_core::crdt::markdown_seed::{plan, seed_document};
use memry_core::crdt::registry::{Document, UpdateSink};
use memry_core::crdt::{DocumentRegistry, extract_text};
use support::{str_field, vector_file};

fn fresh(label: &str) -> Arc<Document> {
    let sink: UpdateSink = Arc::new(|_, _| {});
    DocumentRegistry::new("device-seed", sink)
        .get_or_open("j2099-06-15")
        .unwrap_or_else(|error| panic!("{label}: open: {error}"))
}

/// `withoutBlockIds` of the generator: ` id="…"` off each container line.
fn without_block_ids(canonical: &str) -> String {
    canonical
        .lines()
        .map(|line| {
            let Some(at) = line.find(" id=\"") else {
                return line.to_owned();
            };
            if !line[..at].ends_with("element blockContainer") {
                return line.to_owned();
            }
            let rest = &line[at + 5..];
            let close = rest.find('"').expect("a closing quote");
            format!("{}{}", &line[..at], &rest[close + 1..])
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn every_case_seeds_the_document_desktop_builds() {
    let file = vector_file("markdown-seed");
    let cases = file["cases"].as_array().expect("cases");
    assert!(cases.len() >= 20, "the class lost cases");
    for case in cases {
        let name = str_field(case, "name");
        let markdown = str_field(case, "markdown");
        let document = fresh(name);
        let seeded = seed_document(&document, markdown)
            .unwrap_or_else(|error| panic!("{name}: seed: {error}"));
        assert!(
            seeded.fallbacks.is_empty(),
            "{name}: a vector case fell back: {:?}",
            seeded.fallbacks
        );
        let canonical = canonical_fragment(&document).expect("canonical");
        assert_eq!(
            without_block_ids(&canonical),
            str_field(case, "expectedCanonical"),
            "{name}"
        );
    }
}

#[test]
fn a_seeded_document_reads_through_the_block_and_text_walks() {
    let markdown =
        "## Morning\n- [ ] Stretch\n- [x] Read **one chapter**\n\n> Quote\n\n```ts\nx\n```";
    let document = fresh("walks");
    seed_document(&document, markdown).expect("seed");

    let blocks = extract_blocks(&document).expect("blocks");
    let kinds: Vec<&str> = blocks.iter().map(|block| block.kind.as_str()).collect();
    assert_eq!(
        kinds,
        [
            "heading",
            "checkListItem",
            "checkListItem",
            "quote",
            "codeBlock"
        ]
    );
    assert!(
        blocks
            .iter()
            .all(|block| block.id.as_deref().is_some_and(|id| id.len() == 36))
    );
    let bold = &blocks[2].inline[1];
    assert_eq!(bold.text, "one chapter");
    assert!(bold.marks.iter().any(|mark| mark == "bold"));

    let text = extract_text(&document).expect("text");
    for expected in ["Morning", "Stretch", "one chapter", "Quote", "x"] {
        assert!(text.contains(expected), "{expected} missing from {text:?}");
    }
}

#[test]
fn a_body_with_content_is_never_seeded_again() {
    let document = fresh("twice");
    seed_document(&document, "first").expect("seed");
    assert!(seed_document(&document, "second").is_err());
    let text = extract_text(&document).expect("text");
    assert!(text.contains("first") && !text.contains("second"));
}

/// The fallback for constructs outside the supported set: the block's source
/// lines stay as literal paragraphs, and the plan says which and why.
#[test]
fn unsupported_constructs_keep_their_text_as_literal_paragraphs() {
    let seeded =
        plan("## Log\n| a | b |\n|---|---|\n| 1 | 2 |\n\n![photo](a.png)\n\n> [!info] note");
    let reasons: Vec<&str> = seeded.fallbacks.iter().map(|f| f.reason).collect();
    assert_eq!(reasons, ["table", "image or embed", "callout"]);
    assert_eq!(
        seeded.fallbacks[0].lines,
        ["| a | b |", "|---|---|", "| 1 | 2 |"]
    );

    let document = fresh("fallback");
    seed_document(&document, "<div>html</div>\n\nafter").expect("seed");
    let blocks = extract_blocks(&document).expect("blocks");
    let texts: Vec<&str> = blocks
        .iter()
        .map(|block| block.inline[0].text.as_str())
        .collect();
    assert_eq!(texts, ["<div>html</div>", "after"]);
}
