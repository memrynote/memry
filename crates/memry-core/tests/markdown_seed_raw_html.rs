//! Raw HTML the editor does not handle is kept as literal text in the
//! document, as desktop keeps it (`parseMarkdownToBlocksRepaired`): no
//! fallback, no split paragraph, no character lost.

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
fn a_tag_the_editor_does_not_handle_stays_text_in_its_paragraph() {
    for (markdown, text) in [
        ("kq0 <kbd>Ctrl</kbd> kq1", "kq0 <kbd>Ctrl</kbd> kq1"),
        ("kq0<kq>kq1", "kq0<kq>kq1"),
        ("kq0 <div> kq1", "kq0 <div> kq1"),
        ("kq0 <script>kq9</script>", "kq0 <script>kq9</script>"),
        ("\\<kq>", "\\<kq>"),
        ("<x a=\"*b*\"> and _c_", "<x a=\"*b*\"> and c"),
        ("kq0\n<div>\nkq1", "kq0\n<div>\nkq1"),
        ("kq0 <kq\nb> kq1", "kq0 <kq\nb> kq1"),
        ("kq0 <?x", "kq0 <?x"),
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
fn a_tag_between_emphasis_leaves_the_emphasis_alone() {
    let plan = plan("<kbd>_x_</kbd>");
    assert!(plan.fallbacks.is_empty(), "{:?}", plan.fallbacks);
    let runs: Vec<(String, bool)> = plan.blocks[0]
        .content
        .iter()
        .filter_map(|piece| match piece {
            SeedInline::Text { text, marks } => Some((text.clone(), marks.italic)),
            _ => None,
        })
        .collect();
    assert_eq!(
        runs,
        vec![
            ("<kbd>".to_owned(), false),
            ("x".to_owned(), true),
            ("</kbd>".to_owned(), false)
        ]
    );
}

#[test]
fn a_tag_in_a_quote_a_list_item_a_heading_and_a_cell_stays_text() {
    for markdown in [
        "> kq0 <kbd>x</kbd> kq1",
        "- kq0 <kbd>x</kbd> kq1",
        "# kq0 <kbd>x</kbd> kq1",
        "**kq0 <kbd>x</kbd> kq1**",
        "[kq0 <kbd>x</kbd> kq1](https://e.com)",
        "| a | b |\n| - | - |\n| kq0 <kbd>x</kbd> kq1 | x |",
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
fn no_placeholder_reaches_a_block() {
    for markdown in [
        "kq0 <kbd>x</kbd> kq1",
        "[a <kbd>](https://e.com/<kq>)",
        "![a <kbd>](https://e.com/i.png)",
        "- a <kq>\n- b <kq>",
        "| a <kq> | b |\n| - | - |\n| c <kq> | d |",
    ] {
        let rendered = format!("{:?}", plan(markdown));
        assert!(!rendered.contains("MEMRY"), "{markdown:?}: {rendered}");
    }
}

#[test]
fn a_tag_the_editor_handles_keeps_the_literal_fallback() {
    for markdown in [
        "kq0 <b>x</b> kq1",
        "kq0 <a href=\"u\">x</a>",
        "kq0 <span style=\"color:red\">x</span>",
        "kq0 <br> kq1",
    ] {
        let plan = plan(markdown);
        assert_eq!(plan.fallbacks.len(), 1, "{markdown:?}");
        assert_eq!(plan.fallbacks[0].reason, "HTML", "{markdown:?}");
    }
}
