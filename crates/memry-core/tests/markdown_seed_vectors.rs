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
use memry_core::crdt::markdown_seed::{SeedInline, plan, seed_document};
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

/// Cases desktop builds and the core keeps as literal text, because claiming
/// them needs desktop's serialization of a block the core does not write: a
/// table, a code block or an image under a quote, a comment node, a quoted list, the
/// `<details>` markup a quote, a callout or a heading now keeps as text, a
/// callout, quote or math block indented under a list item, a quote body the
/// writer's underscore spelling stops settling (desktop reads a flat quote,
/// which the core does not build). A
/// fallback is lossless (every line stays text), so each must fall back, and
/// the run it keeps literal is checked below.
const KEPT_LITERAL: [&str; 11] = [
    "comment: %% in a callout body and a quote",
    "callout: a body holding a table",
    "quote: a run opening on a table",
    "quote: a line, a blank and a table",
    "lazy quote line: an image on the line after a quote",
    "quote: a quoted fence then a lazy line",
    "list item child: a callout",
    "list item child: a math block",
    "list item child: a structured quote",
    "list item child: a numbered item's callout",
    "writer: a code span with an underscore before touching runs",
];

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
        if KEPT_LITERAL.contains(&name) {
            assert!(
                !seeded.fallbacks.is_empty(),
                "{name}: the core now builds it, so it is not kept literal"
            );
            let kept: Vec<&str> = seeded
                .fallbacks
                .iter()
                .flat_map(|fallback| fallback.lines.iter().map(String::as_str))
                .collect();
            assert!(
                kept.iter().all(|line| markdown.contains(line)),
                "{name}: a fallback holds a line the source does not: {kept:?}"
            );
            continue;
        }
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

/// Desktop keeps `<details>` markup behind quote markers or a heading's `#`s
/// as text (`escapePrefixedDetailsMarkup`), and raw HTML the editor has no
/// node for is text anywhere. The core builds the quote, callout or heading
/// with the tag as its text; a nested quote or a tab after the marker is a
/// claim it does not prove, so those keep their lines as literal text.
#[test]
fn details_markup_behind_quote_markers_or_hashes_is_text() {
    use memry_core::crdt::markdown_seed::SeedKind;
    for (markdown, text) in [
        ("> <details>", "<details>"),
        ("# <summary>O</summary>", "<summary>O</summary>"),
        ("### </details>", "</details>"),
        ("> [!tip]\n> <details>", "<details>"),
    ] {
        let planned = plan(markdown);
        assert!(planned.fallbacks.is_empty(), "{markdown}");
        let [block] = planned.blocks.as_slice() else {
            panic!("{markdown}: one block");
        };
        assert_ne!(block.kind, SeedKind::Paragraph, "{markdown}");
        assert!(
            matches!(block.content.as_slice(), [SeedInline::Text { text: built, .. }] if built == text),
            "{markdown}"
        );
    }
    for markdown in [">> <details open>", ">\t<summary>O</summary>"] {
        let planned = plan(markdown);
        assert!(!planned.fallbacks.is_empty(), "{markdown}");
        assert!(
            planned
                .blocks
                .iter()
                .all(|block| block.kind == SeedKind::Paragraph),
            "{markdown}"
        );
    }
}

/// A block nesting marker changes the level of the text after it
/// (`parseMarkdownWithNestingMarkers`), and desktop lifts a callout, quote or
/// math run indented under a top-level item into the marker form
/// (`liftItemChildRuns`). The core builds neither, so a source holding one
/// keeps every line as literal text.
#[test]
fn nesting_markers_and_lifted_item_runs_keep_the_whole_source_literal() {
    use memry_core::crdt::markdown_seed::SeedKind;
    for markdown in [
        "- a\n\n<!-- memry:block-nesting-level=1 -->\n\n$$\nx\n$$\n\npara\n\n<!-- memry:block-nesting-level=0 -->",
        "# t\n\n<!--  memry:block-nesting-level=2  -->\n\ntext",
        "- a\n\n  > [!info]\n  > c",
        "- a\n\n  $$\n  x\n  $$",
        "1. a\n\n   > x\n   >\n   > y\n\nafter",
        "-\n\n  > q",
    ] {
        let planned = plan(markdown);
        assert_eq!(planned.fallbacks.len(), 1, "{markdown}");
        assert!(
            planned
                .blocks
                .iter()
                .all(|block| block.kind == SeedKind::Paragraph),
            "{markdown}"
        );
    }
    // Not a lift: no blank line above, an item nested deeper, a fence, a quote
    // at the left edge, indented less than the item's text.
    for markdown in [
        "- a\n  > x",
        "- a\n  - b\n\n    > x",
        "```\n- a\n\n  > x\n```",
        "1. a\n\n> q",
        "- a\n\n > q",
        "text\n\n  > q",
        "* a\n\n    more\n\n   > q",
    ] {
        let planned = plan(markdown);
        assert!(
            !planned
                .fallbacks
                .iter()
                .any(|f| f.reason == "list item holding a callout, quote or math block"),
            "{markdown}: {:?}",
            planned.fallbacks
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
    let seeded = plan(
        "## Log\n<b>Ctrl</b> raw\n\n- [ ] Call {task:abc}\n\n- item ![photo](a.png)\n\nsee ((mention:n1|Note))",
    );
    let reasons: Vec<&str> = seeded.fallbacks.iter().map(|f| f.reason).collect();
    assert_eq!(reasons, ["HTML", "task block", "image in a list or quote"]);
    assert_eq!(seeded.fallbacks[0].lines, ["<b>Ctrl</b> raw"]);

    let document = fresh("fallback");
    seed_document(&document, "<div>html</div>\n\nafter").expect("seed");
    let blocks = extract_blocks(&document).expect("blocks");
    let texts: Vec<&str> = blocks
        .iter()
        .map(|block| block.inline[0].text.as_str())
        .collect();
    assert_eq!(texts, ["<div>html</div>", "after"]);
}
