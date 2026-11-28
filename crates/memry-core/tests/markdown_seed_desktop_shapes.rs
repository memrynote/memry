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

/// A `<!--` comment is not built (chapter 12 §12.7), so a toggle markup line
/// that holds one is the literal text of its block, as it is anywhere else,
/// not text with the comment half-decoded.
#[test]
fn a_comment_in_a_summary_line_that_is_no_toggle_keeps_the_block_as_text() {
    for source in [
        "<details>\n<summary><!-- c --></summary>\n\nx\n\n</details>",
        "<details>\n<summary>a <!-- c --> b</summary>\n\nx\n\n</details>",
        "<details>\n<summary><!-- c --> **b**</summary>\n\nx\n\n</details>",
    ] {
        let seeded = plan(source);
        assert!(
            !seeded.fallbacks.is_empty(),
            "{source:?} was built: {:?}",
            seeded.blocks
        );
    }
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
        "[b](x(y\tz`c`) w)",
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
