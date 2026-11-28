//! `plan` over whole texts. Split from `mod.rs` at its line ceiling.

use super::*;

fn text(value: &str) -> SeedInline {
    SeedInline::Text {
        text: value.to_owned(),
        marks: SeedMarks::default(),
    }
}

#[test]
fn a_block_id_is_a_v4_uuid() {
    let id = random_block_id();
    assert_eq!(id.len(), 36);
    assert_eq!(&id[14..15], "4");
    assert!(matches!(&id[19..20], "8" | "9" | "a" | "b"));
    assert_ne!(id, random_block_id());
}

#[test]
fn pasted_ai_markdown_becomes_memry_blocks() {
    let plan = plan(
        "| a |\n|---|\n| 1 |\n\n> [!note]\n> body\n\n$$\nx^2\n$$\n\n![c](https://e.com/c.png)\n\n```mermaid\nA-->B\n```",
    );
    assert!(plan.fallbacks.is_empty(), "{:?}", plan.fallbacks);
    let kinds: Vec<&SeedKind> = plan.blocks.iter().map(|block| &block.kind).collect();
    assert!(matches!(kinds[0], SeedKind::Table { .. }));
    assert_eq!(
        kinds[1],
        &SeedKind::Callout {
            kind: "note".to_owned(),
            fold: "none".to_owned()
        }
    );
    assert_eq!(plan.blocks[1].content, vec![text("body")]);
    assert_eq!(
        kinds[2],
        &SeedKind::Math {
            latex: "x^2".to_owned()
        }
    );
    assert!(matches!(kinds[3], SeedKind::Image { url, .. } if url == "https://e.com/c.png"));
    assert_eq!(kinds[4], &SeedKind::Diagram);
}

#[test]
fn a_foreign_details_block_stays_its_text() {
    let plan = plan("<details>\n<summary>More</summary>\nbody\n</details>");
    assert!(plan.fallbacks.is_empty(), "{:?}", plan.fallbacks);
    let shown: Vec<&SeedInline> = plan.blocks[0].content.iter().collect();
    assert_eq!(shown[0], &text("<details>"));
    assert_eq!(shown[2], &text("<summary>More</summary>"));
}

#[test]
fn a_tag_the_editor_handles_keeps_its_lines_as_literal_paragraphs() {
    let plan = plan("<b>Ctrl</b> raw\n\nafter");
    assert_eq!(plan.fallbacks[0].reason, "HTML");
    assert_eq!(plan.blocks[0], SeedBlock::literal("<b>Ctrl</b> raw"));
    assert_eq!(
        plan.blocks[1],
        SeedBlock::new(SeedKind::Paragraph, vec![text("after")])
    );
}

#[test]
fn a_comment_in_a_prop_is_the_bytes_it_was() {
    let math = plan("$$\nx %% y %% z\n$$");
    assert!(math.fallbacks.is_empty());
    assert_eq!(
        math.blocks[0].kind,
        SeedKind::Math {
            latex: "x %% y %% z".to_owned()
        }
    );
    let image = plan("![a %% b %% c](https://e.com/i.png)");
    assert!(image.fallbacks.is_empty());
    assert!(matches!(
        &image.blocks[0].kind,
        SeedKind::Image { name, .. } if name == "a %% b %% c"
    ));
    let link = plan("[a](https://e.com/%% b %%)");
    assert!(link.fallbacks.is_empty());
    assert!(matches!(
        &link.blocks[0].content[0],
        SeedInline::Text { marks, .. }
            if marks.link.as_deref() == Some("https://e.com/%% b %%")
    ));
}

#[test]
fn a_html_comment_across_lines_sends_the_whole_text_to_the_fallback() {
    let plan = plan("# a\n\n<!--\n# b\n-->\n\nc");
    assert_eq!(plan.fallbacks[0].reason, "HTML");
    assert_eq!(plan.blocks.len(), 5);
    let single = super::plan("# a\n\n<!-- b -->\n\nc");
    assert_eq!(single.blocks[0].kind, SeedKind::Heading { level: 1 });
}

/// `{anchorId:"dm_1", dateISO:"2026-08-14T09:00:00.000Z", hasTime:false,
/// dateFormat:"relative", remind:"none", timeFormat:"system"}`.
const DATE: &str = "((date:eyJhbmNob3JJZCI6ImRtXzEiLCJkYXRlSVNPIjoiMjAyNi0wOC0xNFQwOTowMDowMC4wMDBaIiwiaGFzVGltZSI6ZmFsc2UsImRhdGVGb3JtYXQiOiJyZWxhdGl2ZSIsInJlbWluZCI6Im5vbmUiLCJ0aW1lRm9ybWF0Ijoic3lzdGVtIn0))";
/// base64url, as builds before the closed alphabet wrote it: `_` in the
/// payload, which the parser would read as emphasis across two tokens.
const UNDERSCORED: &str = "((date:eyJhbmNob3JJZCI6ImRtXz8_IiwiZGF0ZUlTTyI6IjIwMjYtMDgtMTQiLCJoYXNUaW1lIjpmYWxzZSwicmVtaW5kIjoibm9uZSJ9))";
const LINK: &str = "((mention:https%3A%2F%2Fwww.example.com%2Fx))";

fn tokens_in(content: &[SeedInline]) -> Vec<&InlineToken> {
    content
        .iter()
        .filter_map(|piece| match piece {
            SeedInline::Token(token) => Some(token),
            _ => None,
        })
        .collect()
}

fn link(url: &str, domain: &str) -> InlineToken {
    InlineToken::Link {
        url: url.to_owned(),
        domain: domain.to_owned(),
    }
}

#[test]
fn a_token_in_an_unstyled_run_becomes_its_node() {
    let plan = plan(&format!("due {DATE} at {LINK}."));
    assert!(plan.fallbacks.is_empty(), "{:?}", plan.fallbacks);
    let content = &plan.blocks[0].content;
    assert_eq!(content.len(), 5, "{content:?}");
    assert_eq!(content[0], text("due "));
    assert!(
        matches!(&content[1], SeedInline::Token(InlineToken::Date(date)) if date.anchor_id == "dm_1")
    );
    assert_eq!(content[2], text(" at "));
    assert_eq!(
        content[3],
        SeedInline::Token(link("https://www.example.com/x", "example.com"))
    );
    assert_eq!(content[4], text("."));
}

#[test]
fn every_block_kind_and_a_table_cell_promote_but_a_code_block_does_not() {
    let markdown = format!(
        "# {DATE}\n\n- {LINK}\n- [ ] {DATE}\n\n> {LINK}\n\n> [!note]\n> {DATE}\n\n| a |\n|---|\n| {LINK} |\n\n```\n{DATE}\n```"
    );
    let plan = plan(&markdown);
    assert!(plan.fallbacks.is_empty(), "{:?}", plan.fallbacks);
    let promoted: Vec<usize> = plan
        .blocks
        .iter()
        .map(|block| match &block.kind {
            SeedKind::Table { rows } => rows
                .iter()
                .flat_map(|row| &row.cells)
                .map(|cell| tokens_in(&cell.content).len())
                .sum(),
            _ => tokens_in(&block.content).len(),
        })
        .collect();
    assert_eq!(promoted, [1, 1, 1, 1, 1, 1, 0], "{:?}", plan.blocks);
    assert_eq!(plan.blocks[6].content, vec![text(DATE)]);
}

#[test]
fn a_token_in_a_styled_run_or_a_link_stays_text() {
    for markdown in [
        format!("**{DATE}**"),
        format!("`{DATE}`"),
        format!("*{LINK}*"),
        format!("~~{LINK}~~"),
        format!("[{DATE}](https://a.com)"),
    ] {
        let plan = plan(&markdown);
        assert!(
            plan.fallbacks.is_empty(),
            "{markdown}: {:?}",
            plan.fallbacks
        );
        assert!(tokens_in(&plan.blocks[0].content).is_empty(), "{markdown}");
        let shown: String = plan.blocks[0]
            .content
            .iter()
            .filter_map(|piece| match piece {
                SeedInline::Text { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert!(
            shown.contains("((") && shown.contains("))"),
            "{markdown}: {shown}"
        );
    }
}

#[test]
fn a_payload_the_parser_would_read_as_emphasis_reaches_its_node_whole() {
    let plan = plan(&format!("{UNDERSCORED} and {UNDERSCORED}"));
    assert!(plan.fallbacks.is_empty(), "{:?}", plan.fallbacks);
    assert_eq!(
        tokens_in(&plan.blocks[0].content).len(),
        2,
        "{:?}",
        plan.blocks
    );
}

#[test]
fn a_refused_token_stays_text_and_an_undecided_one_keeps_its_line() {
    let refused = plan("a ((date:bm90IGpzb24)) b");
    assert!(refused.fallbacks.is_empty());
    assert_eq!(
        refused.blocks[0].content,
        vec![text("a ((date:bm90IGpzb24)) b")]
    );

    let undecided = plan("see ((mention:http%3A%2F%2F127.1%2F))\n\nnext");
    assert_eq!(undecided.fallbacks.len(), 1);
    assert_eq!(
        undecided.fallbacks[0].lines,
        ["see ((mention:http%3A%2F%2F127.1%2F))"]
    );
    assert_eq!(undecided.blocks[1].content, vec![text("next")]);
}

#[test]
fn a_token_in_a_link_address_or_an_image_keeps_its_line() {
    for markdown in [
        format!("[a]({LINK})"),
        format!("![{DATE}](https://a.com/i.png)"),
    ] {
        let plan = plan(&markdown);
        assert_eq!(plan.fallbacks.len(), 1, "{markdown}");
        assert_eq!(plan.fallbacks[0].lines, [markdown.as_str()]);
        // The literal line's token is still promoted: a fallback never shows
        // a payload.
        assert_eq!(tokens_in(&plan.blocks[0].content).len(), 1, "{markdown}");
    }
}

#[test]
fn a_seeded_token_is_the_node_desktop_writes() {
    let sink: crate::crdt::registry::UpdateSink = std::sync::Arc::new(|_, _| {});
    let document = crate::crdt::DocumentRegistry::new("device-seed", sink)
        .get_or_open("note-seed")
        .expect("open");
    seed_document(&document, &format!("via {LINK}")).expect("seed");
    let canonical = crate::crdt::canonical_fragment(&document).expect("canonical");
    let lines: Vec<&str> = canonical.lines().skip(2).collect();
    assert_eq!(
        lines,
        [
            "2 element paragraph backgroundColor=\"default\" textAlignment=\"left\" textColor=\"default\"",
            "3 text \"via \"",
            "3 element linkMention domain=\"example.com\" favicon=\"\" siteName=\"\" title=\"\" url=\"https://www.example.com/x\"",
        ]
    );
}
