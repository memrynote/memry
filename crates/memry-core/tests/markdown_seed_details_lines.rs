//! A `<details>` markup line no toggle claimed reads as text, a tag the editor
//! handles inside it included, and a backslash before such a tag is its escape,
//! as in a paragraph (`parse-markdown.ts` `escapePrefixedDetailsMarkup`). The
//! writer spells the text that way, so a line that reads one spelling reads the
//! other as the same characters.

use memry_core::crdt::markdown_seed::{SeedInline, plan};

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

fn text_of_plan(markdown: &str) -> String {
    let plan = plan(markdown);
    assert!(
        plan.fallbacks.is_empty(),
        "{markdown:?}: {:?}",
        plan.fallbacks
    );
    assert_eq!(plan.blocks.len(), 1, "{markdown:?}");
    text_of(&plan.blocks[0].content)
}

fn foreign(summary: &str) -> String {
    format!("<details>\n<summary>{summary}</summary>\ny\n</details>")
}

#[test]
fn a_bare_and_an_escaped_handled_tag_in_a_summary_read_as_the_same_text() {
    for (bare, escaped) in [
        ("<b>x</b>", "\\<b>x\\</b>"),
        ("Use <i>this</i>", "Use \\<i>this\\</i>"),
        ("a<br>b", "a\\<br>b"),
        (
            "<a href=\"https://e.com\">x</a>",
            "\\<a href=\"https://e.com\">x\\</a>",
        ),
    ] {
        let text = text_of_plan(&foreign(bare));
        assert_eq!(text, foreign(bare), "{bare:?}");
        assert_eq!(text_of_plan(&foreign(escaped)), text, "{escaped:?}");
    }
}

#[test]
fn a_backslash_before_a_tag_the_editor_does_not_handle_stays_in_a_summary() {
    let markdown = foreign("C:\\<path>");
    assert_eq!(text_of_plan(&markdown), markdown);
}

#[test]
fn a_backslash_pair_before_a_tag_is_one_backslash_and_the_tag() {
    assert_eq!(
        text_of_plan(&foreign("\\\\<b>x</b>")),
        foreign("\\<b>x</b>")
    );
}
