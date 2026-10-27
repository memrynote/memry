//! Oracle-free properties of the converter over generated markdown: it never
//! panics, its output stays bounded, and house style is a fixed point (what the
//! converter writes, it reads back to the same document and writes again
//! unchanged). The frontmatter split property lives in
//! `markdown_frontmatter_proptest.rs`. The oracle comparison is
//! `markdown_differential.rs`.

#![cfg(feature = "markdown")]

mod support;

use memry_test_kit::{DEFAULT_CASES, assert_output_bounded, output_bound, proptest_config};
use proptest::prelude::*;
use serde_json::Value as Json;
use support::doc_case::{
    FRAGMENT, build_document, converter_for, files_of, roundtrip_of, serialized, sorted,
};

fn config() -> ProptestConfig {
    ProptestConfig {
        failure_persistence: None,
        ..proptest_config(DEFAULT_CASES)
    }
}

/// Inline forms that survive anywhere: not a hard break (a table cell is one
/// line) and not an image (a heading holding only an image is lifted).
fn word() -> impl Strategy<Value = String> {
    prop_oneof![
        "[a-zA-Z0-9]{1,8}",
        "[a-z]{1,12}",
        Just("*em*".to_owned()),
        Just("**strong**".to_owned()),
        Just("~~gone~~".to_owned()),
        Just("`code`".to_owned()),
        Just("[link](https://example.com/a_b)".to_owned()),
        Just("[[Wiki Link]]".to_owned()),
        Just("#tag".to_owned()),
        Just("<!-- note -->".to_owned()),
        Just("é日本😀".to_owned()),
        Just("1 < 2 & 3".to_owned()),
        Just("[^1]".to_owned()),
        Just("$x^2$".to_owned()),
    ]
}

fn text() -> impl Strategy<Value = String> {
    prop::collection::vec(word(), 1..5).prop_map(|w| w.join(" "))
}

/// Words with no marks: a quote holding emphasis loses its closing delimiter
/// in the TypeScript (pinned by the differential run, not by this one).
fn plain() -> impl Strategy<Value = String> {
    "[a-zA-Z0-9]{1,8}( [a-z0-9]{1,8}){0,3}"
}

/// A paragraph line: `text`, an image or a hard break in the middle.
fn paragraph() -> impl Strategy<Value = String> {
    prop_oneof![
        4 => text(),
        1 => text().prop_map(|t| format!("{t} ![img](a.png)")),
        1 => text().prop_map(|t| format!("{t}  \nnext {t}")),
    ]
}

/// Blocks that read back the same wherever they sit.
fn simple_block() -> BoxedStrategy<Vec<String>> {
    prop_oneof![
        text().prop_map(|t| vec![t]),
        (1..=3usize, text()).prop_map(|(n, t)| vec![format!("{} {t}", "#".repeat(n))]),
        text().prop_map(|t| vec![format!("- {t}")]),
        text().prop_map(|t| vec![format!("1. {t}")]),
        text().prop_map(|t| vec![format!("- [ ] {t}")]),
        text().prop_map(|t| vec![format!("- [x] {t}")]),
    ]
    .boxed()
}

/// Blocks that are stable at the top level only: the TypeScript drops or
/// re-spaces them inside a list item (pinned by the differential run).
fn top_block() -> BoxedStrategy<Vec<String>> {
    prop_oneof![
        paragraph().prop_map(|t| vec![t]),
        (
            prop::sample::select(vec!["```", "~~~", "````"]),
            text(),
            0..3usize
        )
            .prop_map(|(fence, t, n)| {
                let mut lines = vec![format!("{fence}rust")];
                lines.extend((0..=n).map(|_| t.clone()));
                lines.push(fence.to_owned());
                lines
            }),
        Just(vec!["---".to_owned()]),
        (text(), text()).prop_map(|(a, b)| vec![
            format!("| {a} | {b} |"),
            "| --- | --- |".to_owned(),
            format!("| {b} | {a} |")
        ]),
        text().prop_map(|t| vec![format!("<!-- {t} -->")]),
    ]
    .boxed()
}

/// Lists nested up to `depth` levels. A quote or a math fence inside a list
/// item is not stable after one pass in the TypeScript either (the oracle gives
/// `> *em\n>* **strong**` for a list in a quote, checked with the oracle on
/// 2026-10-26), so the fixed-point property cannot hold there for any correct
/// port. The differential run covers those shapes against the oracle, so they
/// are top level here only. Follow-up for the TypeScript owner: the quote
/// serializer drops a closing `*` on a continued line.
fn list_tree(depth: u32) -> BoxedStrategy<Vec<String>> {
    if depth == 0 {
        return simple_block();
    }
    prop_oneof![
        3 => simple_block(),
        1 => (text(), list_tree(depth - 1)).prop_map(|(head, inner)| {
            let mut lines = vec![format!("- {head}")];
            lines.extend(inner.into_iter().map(|l| format!("  {l}")));
            lines
        }),
    ]
    .boxed()
}

/// One top-level block, its lines.
fn block() -> BoxedStrategy<Vec<String>> {
    prop_oneof![
        6 => list_tree(4),
        3 => top_block(),
        1 => plain().prop_map(|t| vec![format!("> {t}")]),
        1 => plain().prop_map(|t| vec![format!("> [!note] {t}"), "> body".to_owned()]),
        1 => Just(vec!["$$".to_owned(), "x^2".to_owned(), "$$".to_owned()]),
    ]
    .boxed()
}

fn document() -> impl Strategy<Value = String> {
    (
        prop::collection::vec(block(), 1..6),
        prop::sample::select(vec!["\n", "\r\n"]),
        any::<bool>(),
    )
        .prop_map(|(blocks, eol, final_newline)| {
            let mut out = blocks
                .into_iter()
                .map(|b| b.join("\n"))
                .collect::<Vec<_>>()
                .join("\n\n");
            if final_newline {
                out.push('\n');
            }
            out.replace('\n', eol)
        })
}

/// Anything at all, hostile characters included.
fn noise() -> impl Strategy<Value = String> {
    prop_oneof![
        "\\PC{0,200}",
        "[\\[\\]()*_`~#>|!\\\\<$%-]{0,60}",
        prop::collection::vec(
            prop::sample::select(vec![
                "\u{2028}", "\u{feff}", "\0", "\\", "\r", "\n", "```", "~~~", "|", "- ", "> ",
                "# ", "[[", "]]", "$$", "<!--", "-->", "%%", "{{", "![", "](",
            ]),
            0..40
        )
        .prop_map(|p| p.concat()),
    ]
}

/// Seed and read back house style. `None` when the converter fails closed.
fn canonical_of(markdown: &str) -> Option<String> {
    roundtrip_of(markdown)
        .ok()
        .and_then(|got| got["canonical"].as_str().map(str::to_owned))
}

proptest! {
    #![proptest_config(config())]

    /// (a) After one pass the output is stable, and (b) a document seeded from
    /// it writes it back, whether or not the source record is kept.
    #[test]
    fn house_style_is_a_fixed_point(md in document()) {
        let Some(once) = canonical_of(&md) else { return Ok(()) };
        let again = canonical_of(&once);
        prop_assert_eq!(again.as_deref(), Some(once.as_str()));

        let got = roundtrip_of(&once).expect("seeded");
        prop_assert_eq!(got["markdown"].as_str(), Some(once.as_str()));
        let outcome = got["outcome"].as_str().unwrap_or("");
        prop_assert!(outcome == "source" || outcome == "no-record", "outcome {outcome}");
    }

    /// (c) The block view of a document equals the block view of the document
    /// seeded from what that document writes.
    #[test]
    fn blocks_survive_a_seed_and_a_write(md in document()) {
        let input = serde_json::json!({ "markdown": md });
        let converter = converter_for(&input);
        let files = files_of(&input);
        let Ok(doc) = build_document(&converter, &input, &files) else { return Ok(()) };
        let Some(first) = converter.blocks(&doc, FRAGMENT) else { return Ok(()) };
        let Some(written) = converter.doc_to_canonical_markdown(&doc, FRAGMENT) else { return Ok(()) };
        let input = serde_json::json!({ "markdown": written });
        let doc = build_document(&converter, &input, &files).expect("seeded");
        let second = converter.blocks(&doc, FRAGMENT).expect("blocks");
        prop_assert_eq!(sorted(&Json::Array(first)), sorted(&Json::Array(second)));
    }

    /// (d) No panic, valid UTF-8 by construction, output bounded by the input.
    #[test]
    fn hostile_input_is_bounded(md in noise()) {
        if let Ok(got) = roundtrip_of(&md) {
            for key in ["markdown", "canonical"] {
                if let Some(out) = got[key].as_str() {
                    prop_assert!(out.len() <= output_bound(md.len()), "{key}: {} from {}", out.len(), md.len());
                }
            }
        }
    }

    #[test]
    fn generated_documents_are_bounded(md in document()) {
        let input = serde_json::json!({ "markdown": md });
        let converter = converter_for(&input);
        let files = files_of(&input);
        if let Ok(doc) = build_document(&converter, &input, &files) {
            let got = serialized(&converter, &doc, &input, &files);
            for key in ["markdown", "canonical"] {
                if let Some(out) = got[key].as_str() {
                    prop_assert!(out.len() <= output_bound(md.len()));
                }
            }
        }
    }
}

/// `splitByCodeFences` rescanned a fence after a `\r`, U+2028 or U+2029 inside the
/// closing line and copied the tail again per fence: 31 bytes became 328 and
/// 24 KB of such fences 24 MB. proptest found it on windows-2022 (PR #3613).
#[test]
fn fences_after_line_terminators_do_not_copy_text() {
    let found = "```[[\r```\u{2028}```<!--``````|- ```";
    let many = format!("```\n```\u{2028}{}", "```\u{2028}".repeat(4000));
    for md in [found, many.as_str()] {
        let got = roundtrip_of(md).expect("builds");
        for key in ["markdown", "canonical"] {
            let out = got[key].as_str().expect(key);
            assert_output_bounded(key, md.len(), out.len());
        }
    }
}
