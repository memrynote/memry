//! A backslash before a tag the editor handles escapes its angle bracket: the
//! tag is literal text and the backslash is gone, as on desktop
//! (`inline/raw-html.ts`). The text a document holds that spells such a tag is
//! written that way (`escapeMarkdownText`), so the seed of the markdown that
//! writer produced is a document the writer writes back unchanged: no fallback.
//! A backslash before a tag the editor does not handle is text.

use memry_core::crdt::markdown_seed::{SeedInline, SeedKind, plan};

/// The text of every run of a block's content, a break as `\n`.
fn text_of(content: &[SeedInline]) -> String {
    content
        .iter()
        .map(|piece| match piece {
            SeedInline::Text { text, .. } => text.as_str(),
            SeedInline::HardBreak { .. } => "\n",
            _ => "",
        })
        .collect()
}

#[test]
fn an_escaped_handled_tag_is_text_in_its_paragraph() {
    for (markdown, text) in [
        ("\\<b>x\\</b>", "<b>x</b>"),
        ("a \\<strong>x\\</strong> b", "a <strong>x</strong> b"),
        ("a \\<a href=\"u\">x\\</a> b", "a <a href=\"u\">x</a> b"),
        ("a \\<img src=x> b", "a <img src=x> b"),
        ("a \\<br> b \\<br/> c", "a <br> b <br/> c"),
        ("\\<ul>\\<li>x\\</li>\\</ul>", "<ul><li>x</li></ul>"),
        ("\\<table>\\<tr>\\<td>x", "<table><tr><td>x"),
        (
            "a \\<details data-memry-toggle> b",
            "a <details data-memry-toggle> b",
        ),
        (
            "a \\<input type=\"checkbox\"> b",
            "a <input type=\"checkbox\"> b",
        ),
        ("\\\\\\<b>x", "\\<b>x"),
    ] {
        let plan = plan(markdown);
        assert!(
            plan.fallbacks.is_empty(),
            "{markdown:?}: {:?}",
            plan.fallbacks
        );
        assert_eq!(plan.blocks.len(), 1, "{markdown:?}");
        assert_eq!(plan.blocks[0].kind, SeedKind::Paragraph, "{markdown:?}");
        assert_eq!(text_of(&plan.blocks[0].content), text, "{markdown:?}");
    }
}

#[test]
fn a_tag_after_an_escaped_backslash_is_a_tag_again() {
    let plan = plan("\\\\<b>x</b>");
    assert_eq!(plan.fallbacks.len(), 1);
}

#[test]
fn an_escaped_handled_tag_is_text_in_a_heading_a_quote_a_list_item_and_a_cell() {
    for markdown in [
        "# \\<b>x\\</b>",
        "> \\<b>x\\</b>",
        "- \\<b>x\\</b>",
        "**\\<i>x\\</i>**",
        "[\\<b>x\\</b>](https://e.com)",
        "| a | b |\n| - | - |\n| \\<b>x\\</b> | y |",
    ] {
        let plan = plan(markdown);
        assert!(
            plan.fallbacks.is_empty(),
            "{markdown:?}: {:?}",
            plan.fallbacks
        );
    }
}

#[test]
fn a_backslash_before_a_tag_the_editor_does_not_handle_is_kept() {
    for markdown in [
        "\\<kq>",
        "\\</kq>",
        "\\<kbd>x\\</kbd>",
        "\\<x a=\"*\">",
        "\\<div>",
    ] {
        let plan = plan(markdown);
        assert!(plan.fallbacks.is_empty(), "{markdown:?}");
        assert_eq!(text_of(&plan.blocks[0].content), markdown, "{markdown:?}");
    }
}

#[test]
fn a_backslash_before_an_unfinished_tag_is_kept() {
    for markdown in ["\\<b x", "\\<b", "a \\<ul"] {
        let plan = plan(markdown);
        assert!(!plan.blocks.is_empty(), "{markdown:?}");
        if plan.fallbacks.is_empty() {
            assert_eq!(text_of(&plan.blocks[0].content), markdown, "{markdown:?}");
        }
    }
}

#[test]
fn an_escaped_tag_counts_for_nothing_against_the_nesting_cap() {
    let markdown = format!("{}x{}", "\\<b>".repeat(500), "\\</b>".repeat(500));
    let plan = plan(&markdown);
    assert!(plan.fallbacks.is_empty(), "{:?}", plan.fallbacks);
    assert_eq!(
        text_of(&plan.blocks[0].content),
        format!("{}x{}", "<b>".repeat(500), "</b>".repeat(500))
    );
}
