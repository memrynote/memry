//! An HTML comment inside a tag the editor does not handle is part of the tag
//! on desktop (`inline/raw-html.ts`): the characters of one text run. This
//! seed builds no `<!--` comment, and where it cannot tell which characters
//! desktop reads as the tag (the bound counts the comment's token, a `>` or a
//! quote in it ends a tag early), a block holding one goes to the fallback, as
//! every other `<!--` does. An Obsidian `%%` comment is masked here as it is
//! there, so it is a node in the tag's text on both sides.

use memry_core::crdt::markdown_seed::{SeedInline, plan};

#[test]
fn a_comment_inside_a_hidden_tag_sends_its_block_to_the_fallback() {
    for markdown in [
        "a <kq a=\"<!-- c -->\"> b",
        "a <?x <!-- c -->?> b",
        "a <![CDATA[ <!-- c --> ]]> b",
        "a <!x <!-- c --> > b",
        "# h <kq a=\"<!-- c -->\">",
        "- item <kq a=\"<!-- c -->\">",
        "**a <kq a=\"<!-- c -->\">** b",
        "| a | b |\n| - | - |\n| <kq a=\"<!-- c -->\"> | y |",
    ] {
        let plan = plan(markdown);
        assert_eq!(
            plan.fallbacks.len(),
            1,
            "{markdown:?}: {:?}",
            plan.fallbacks
        );
        assert_eq!(plan.fallbacks[0].reason, "HTML", "{markdown:?}");
    }
}

#[test]
fn an_obsidian_comment_inside_a_hidden_tag_is_a_node_in_its_text() {
    let plan = plan("a <kq a=\"%% c %%\"> b");
    assert!(plan.fallbacks.is_empty(), "{:?}", plan.fallbacks);
    let comments: Vec<&str> = plan.blocks[0]
        .content
        .iter()
        .filter_map(|piece| match piece {
            SeedInline::HtmlComment { source } => Some(source.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(comments, ["%% c %%"]);
}
