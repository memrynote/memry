//! Shapes where the seed and desktop's parse disagreed, each held to what
//! desktop builds (`packages/contracts/test-vectors/markdown-seed.json` holds
//! the rest of the cases both sides share).

use memry_core::crdt::markdown_seed::{SeedInline, SeedKind, plan};

fn flat(content: &[SeedInline]) -> String {
    content
        .iter()
        .map(|piece| match piece {
            SeedInline::Text { text, .. } => text.as_str(),
            SeedInline::HardBreak { .. } => "\n",
            _ => "<node>",
        })
        .collect()
}

fn links_in(content: &[SeedInline]) -> Vec<&str> {
    content
        .iter()
        .filter_map(|piece| match piece {
            SeedInline::Text { marks, .. } => marks.link.as_deref(),
            _ => None,
        })
        .collect()
}

/// Desktop masks every comment before it reads a line, so the comment in the
/// summary line of a `<details>` block that is no toggle is a node among the
/// text of its paragraph, not the bytes of a comment half-decoded into text.
#[test]
fn a_comment_in_a_summary_line_that_is_no_toggle_is_a_node() {
    let seeded = plan("<details>\n<summary>a <!-- c --> b</summary>\n\nx\n\n</details>");
    assert!(seeded.fallbacks.is_empty(), "{:?}", seeded.fallbacks);
    let nodes: Vec<String> = seeded.blocks[0]
        .content
        .iter()
        .map(|piece| match piece {
            SeedInline::Text { text, .. } => format!("text {text:?}"),
            SeedInline::HardBreak { .. } => "break".to_owned(),
            SeedInline::HtmlComment { source } => format!("comment {source:?}"),
            other => format!("{other:?}"),
        })
        .collect();
    assert_eq!(
        nodes,
        [
            "text \"<details>\"",
            "break",
            "text \"<summary>a \"",
            "comment \"<!-- c -->\"",
            "text \" b</summary>\"",
        ]
    );
}

/// An address the parse cuts at a blank, with a parenthesis open in it, cannot
/// be written back and read again as the same link or image, so the line stays
/// the text it was.
#[test]
fn an_address_cut_inside_a_parenthesis_is_the_text_it_was() {
    for source in [
        "[b]([](u\nv))",
        "[b]([](u\nv) \"t\")",
        "a [b]([](u\nv)) c",
        "[b](x(y\nz) w)",
        "[b](x(y\tz\nw) w)",
        "![i](x(y z) w)",
        "![a]([](u\nv))",
    ] {
        let seeded = plan(source);
        assert!(
            seeded.fallbacks.is_empty(),
            "{source:?}: {:?}",
            seeded.fallbacks
        );
        assert_eq!(seeded.blocks.len(), 1, "{source:?}: {:?}", seeded.blocks);
        let block = &seeded.blocks[0];
        assert!(matches!(block.kind, SeedKind::Paragraph), "{source:?}");
        assert_eq!(flat(&block.content), source, "{source:?}");
        assert!(links_in(&block.content).is_empty(), "{source:?}");
    }
}

/// An address with a blank and balanced parentheses is the link's `href` as
/// written (BBF-109), and one with no blank in it is a link as it always was.
#[test]
fn a_balanced_address_stays_a_link() {
    for (source, href) in [
        ("[b](x(y z) w)", "x(y z) w"),
        ("[b](x(y)z)", "x(y)z"),
        ("[b](x(y z))", "x(y z)"),
    ] {
        let seeded = plan(source);
        assert_eq!(
            links_in(&seeded.blocks[0].content),
            vec![href],
            "{source:?}"
        );
    }
}

fn nodes(content: &[SeedInline]) -> Vec<String> {
    content
        .iter()
        .map(|piece| match piece {
            SeedInline::Text { text, marks } if marks.code => format!("code {text:?}"),
            SeedInline::Text { text, .. } => format!("text {text:?}"),
            SeedInline::HtmlComment { source } => format!("comment {source:?}"),
            other => format!("{other:?}"),
        })
        .collect()
}

/// A backslash makes a backtick text, so a comment between two of them is a
/// comment node among the text, as it is on desktop.
#[test]
fn a_comment_between_escaped_backticks_is_a_node() {
    for (source, expected) in [
        (
            "\\`%%x%%\\`",
            vec!["text \"`\"", "comment \"%%x%%\"", "text \"`\""],
        ),
        (
            "a \\`%%x%%\\` b",
            vec!["text \"a `\"", "comment \"%%x%%\"", "text \"` b\""],
        ),
        ("\\\\`%%x%%`", vec!["text \"\\\\\"", "code \"%%x%%\""]),
    ] {
        let seeded = plan(source);
        assert!(seeded.fallbacks.is_empty(), "{source:?}");
        assert_eq!(nodes(&seeded.blocks[0].content), expected, "{source:?}");
    }
}

/// A summary line gets the same comment scan as the text around it.
#[test]
fn a_comment_between_escaped_backticks_in_a_summary_line_is_a_node() {
    let seeded = plan("<details>\n<summary>\\`<!-- c -->\\`</summary>\n\nx\n\n</details>");
    assert!(seeded.fallbacks.is_empty(), "{:?}", seeded.fallbacks);
    assert_eq!(
        nodes(&seeded.blocks[0].content)[2..],
        [
            "text \"<summary>`\"",
            "comment \"<!-- c -->\"",
            "text \"`</summary>\""
        ]
    );
}

/// A run of backticks with no closer of its length retries from each later
/// backtick of the run, as the parser does, so a comment the span reaches is
/// the span's own bytes: `a``x b`c` is `a`, a span `x b`, then `c`.
#[test]
fn a_comment_in_a_span_the_run_retries_into_is_code() {
    for (source, expected) in [
        (
            "a``%%x%%b`c",
            vec!["text \"a`\"", "code \"%%x%%b\"", "text \"c\""],
        ),
        (
            "a``%%x%%b`c`",
            vec!["text \"a`\"", "code \"%%x%%b\"", "text \"c`\""],
        ),
        ("\\``%%x%%`", vec!["text \"`\"", "code \"%%x%%\""]),
    ] {
        let seeded = plan(source);
        assert!(seeded.fallbacks.is_empty(), "{source:?}");
        assert_eq!(nodes(&seeded.blocks[0].content), expected, "{source:?}");
    }
}
