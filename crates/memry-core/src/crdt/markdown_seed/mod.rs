//! Markdown → BlockNote document seed (spec 005-journal JP022a).
//!
//! **Why the core parses markdown here (chapter 12 §12.1.0).** A day seeded
//! from a template on the phone has only `seed_markdown` until something turns
//! it into a document, and the iOS app converts no markdown of its own
//! (§5 fact c): the day would read "not on this phone", and the first
//! keystroke would write blocks into an empty document that desktop's next
//! write-back puts over the template text. So the core seeds the document
//! itself. Text pasted into a block on iOS, a filed inbox article and a note
//! created from a template go through the same [`plan`].
//!
//! **The document must be the one desktop would build** from the same bytes
//! (`apps/desktop/src/main/sync/blocknote-converter.ts` `markdownToYFragment`,
//! BlockNote 0.54's `markdownToHtml` and HTML parse, desktop's repairs around
//! them). Each stage is ported from its source, including its quirks: `1. `
//! on the last line is the paragraph `1.` because the text is `trim()`med
//! first; a soft break is one `hardBreak` and a hard break two; a code span
//! drops every other mark. `packages/contracts/test-vectors/markdown-seed.json`
//! pins the result, generated through the production parse path. A paste
//! follows the converter too, not BlockNote's own paste of `text/plain`: the
//! converter is the desktop reading that builds Memry's blocks (callouts,
//! math, toggles, embeds), and the one every vault file goes through.
//!
//! **Built**: paragraphs, headings 1–6 (ATX and setext), bullet, numbered
//! and check lists nested by indentation, quotes, fenced and indented code
//! blocks with their language, mermaid diagrams, dividers, pipe tables,
//! images and videos (a line of its own, or lifted out of a paragraph or
//! heading, or inline in a table cell), YouTube, bookmark, whiteboard and file
//! marker lines, callouts, `$$` math blocks, quotes with a blank `>` line
//! between paragraphs, Memry's `<details data-memry-toggle>` toggles, and
//! inline bold, italic, strike, code and links, and Obsidian `%% … %%`
//! comments as `htmlComment` nodes ([`comments`], [`comment_nodes`]). Wiki
//! links, tags and `{{…}}`
//! tokens stay plain text, which is what desktop's converter does with them
//! too, and so does a `<details>` block another app wrote.
//!
//! **Fallback**: a construct outside that set (raw HTML and `<!--` comments, an
//! image in a list or a quote, a video beside text, an inline mention or date
//! token, a task block or plain-checkbox marker, a quote or callout holding a
//! list or a nested quote, a callout of a user-defined type or with a body
//! this port cannot serialize back) keeps its block's source lines as literal
//! text, one paragraph per non-blank line, and is reported in
//! [`SeedPlan::fallbacks`]. A construct that changes how desktop reads the
//! whole text (CriticMarkup, a link reference definition, column regions, a
//! coloured toggle) sends every line there. A fallback drops no text; the
//! document then differs from desktop's in those blocks only.
//!
//! **A table keeps every cell, as desktop's does.** A `|` inside a code span
//! splits no cell, and a body row wider than the header row widens the table,
//! the header and the shorter rows padded with empty cells, unless the header
//! row is spelled like a delimiter row, which cuts the rows to its width
//! ([`table`]'s `try_parse_table`). Desktop builds the same table from the
//! same row.

mod blocks;
mod claims;
mod closers;
mod code_spans;
mod collapse;
mod comment_nodes;
mod comments;
mod hard_breaks;
mod inline;
mod lift;
mod links;
mod markers;
mod media;
mod prepare;
mod roundtrip;
mod runs;
mod shapes;
mod table;
mod toggles;
mod tokens;
mod web_url;
mod write;

use yrs::{ReadTxn as _, XmlFragment as _};

pub(crate) use links::destination as link_destination;

use crate::crdt::errors::CrdtError;
use crate::crdt::{BODY_FRAGMENT, Document};

/// One block the seed writes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeedBlock {
    pub kind: SeedKind,
    /// Inline content. A code block holds one unmarked text with its newlines.
    pub content: Vec<SeedInline>,
    pub children: Vec<SeedBlock>,
}

/// The block types a seed builds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SeedKind {
    Paragraph,
    Heading {
        level: u8,
    },
    BulletListItem,
    /// `start` is set on the first item of an ordered list that does not
    /// start at 1.
    NumberedListItem {
        start: Option<u32>,
    },
    CheckListItem {
        checked: bool,
    },
    Quote,
    /// `""` for an untagged fence: Memry's schema parses one with no
    /// language rather than the `javascript` default (BBF-114).
    CodeBlock {
        language: String,
    },
    /// A ```` ```mermaid ```` fence: its source as plain content.
    Diagram,
    /// `<details data-memry-toggle>`: the summary is its content, the body
    /// its children.
    Toggle {
        open: bool,
    },
    Divider,
    /// `kind` is the callout type (`note`, `tip`, …), `fold` `none`,
    /// `closed` or `open`. The first paragraph is its content, the blocks
    /// after it its children.
    Callout {
        kind: String,
        fold: String,
    },
    Math {
        latex: String,
    },
    /// `name` is the markdown's alt text, without the `|300` width suffix
    /// that becomes `preview_width`.
    Image {
        url: String,
        name: String,
        preview_width: Option<u32>,
    },
    Video {
        url: String,
        name: String,
    },
    YoutubeEmbed {
        video_id: String,
        video_url: String,
        alt: String,
    },
    Bookmark {
        url: String,
        domain: String,
    },
    Whiteboard {
        canvas_id: String,
    },
    /// A `<!-- file:{…} -->` marker line's props.
    File(FileProps),
    /// A pipe table: its rows, the first one of `tableHeader` cells when the
    /// markdown's header row is not blank.
    Table {
        rows: Vec<SeedRow>,
    },
}

/// The props of a `file` block, as its marker line's JSON gives them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileProps {
    pub url: String,
    pub name: String,
    pub size: serde_json::Number,
    pub mime_type: String,
    pub width: serde_json::Number,
    pub height: serde_json::Number,
    pub align: String,
    /// `display: "link"`; any other display is the default viewer.
    pub link: bool,
}

/// One table row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeedRow {
    pub cells: Vec<SeedCell>,
}

/// One table cell: a `tableHeader` or a `tableCell`, holding one
/// `tableParagraph` of inline content.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeedCell {
    pub header: bool,
    pub content: Vec<SeedInline>,
}

/// One piece of inline content.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SeedInline {
    Text {
        text: String,
        marks: SeedMarks,
    },
    HardBreak,
    /// An `htmlComment` node: a `%% … %%` comment as written, delimiters
    /// included (chapter 12 §12.7).
    HtmlComment {
        source: String,
    },
    /// An image inside a table cell (`inlineImage`); `width` 0 is unset.
    InlineImage {
        src: String,
        alt: String,
        width: u32,
    },
}

/// The marks on one text run.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SeedMarks {
    pub bold: bool,
    pub italic: bool,
    pub strike: bool,
    pub code: bool,
    pub link: Option<String>,
}

/// Source lines kept as literal text, and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeedFallback {
    pub reason: &'static str,
    pub lines: Vec<String>,
}

/// What a markdown text seeds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeedPlan {
    pub blocks: Vec<SeedBlock>,
    pub fallbacks: Vec<SeedFallback>,
}

/// A construct this seed does not build, and its name for the report.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Unsupported(&'static str);

impl SeedBlock {
    fn new(kind: SeedKind, content: Vec<SeedInline>) -> Self {
        Self {
            kind,
            content,
            children: Vec::new(),
        }
    }

    fn empty_paragraph() -> Self {
        Self::new(SeedKind::Paragraph, Vec::new())
    }

    fn literal(line: &str) -> Self {
        Self::new(
            SeedKind::Paragraph,
            vec![SeedInline::Text {
                text: line.to_owned(),
                marks: SeedMarks::default(),
            }],
        )
    }
}

/// The blocks `markdown` seeds, without touching a document. Plain text
/// pasted into a block makes the same blocks (chapter 12 §12.1.0).
pub fn plan(markdown: &str) -> SeedPlan {
    // `withLfLineEndings`: the parse would read a `\r` as a space.
    let markdown = &markdown.replace("\r\n", "\n").replace('\r', "\n");
    let mut out = Vec::new();
    let mut fallbacks = Vec::new();
    let parsed = match prepare::document_fallback(markdown) {
        Some(reason) => Err(Unsupported(reason)),
        None => {
            // `markdownToBlocks`: every comment is masked before any line is
            // split.
            let masked = comments::mask(markdown);
            if masked.multiline_html {
                Err(Unsupported("HTML"))
            } else {
                parse_masked(
                    &media::separate_block_images(&masked.text),
                    &mut out,
                    &mut fallbacks,
                )
            }
        }
    };
    if let Err(Unsupported(reason)) = parsed {
        let lines: Vec<String> = markdown
            .split('\n')
            .map(|line| crate::domain::journal_rules::js_trim(line).to_owned())
            .filter(|line| !line.is_empty())
            .collect();
        return SeedPlan {
            blocks: lines.iter().map(|line| SeedBlock::literal(line)).collect(),
            fallbacks: vec![SeedFallback { reason, lines }],
        };
    }
    restore_details_markup(&mut out);
    for fallback in &mut fallbacks {
        for line in &mut fallback.lines {
            *line = line.replace(toggles::DETAILS_LT_TOKEN, "<");
        }
    }
    SeedPlan {
        blocks: out,
        fallbacks,
    }
}

/// `parseMaskedMarkdown` and `parseMarkdownWithToggles`: toggles first, each
/// body read the same way, then each markdown segment split at its blank
/// lines and read line by line.
fn parse_masked(
    markdown: &str,
    out: &mut Vec<SeedBlock>,
    fallbacks: &mut Vec<SeedFallback>,
) -> Result<(), Unsupported> {
    for segment in toggles::split_by_toggles(markdown)? {
        match segment {
            toggles::Segment::Toggle {
                summary,
                body,
                open,
            } => {
                // `parseToggleSegment`: the summary's first block's content.
                let mut parsed = Vec::new();
                let mut summary_fallbacks = Vec::new();
                blocks::parse_chunk(&summary, &mut parsed, &mut summary_fallbacks);
                if let Some(fallback) = summary_fallbacks.first() {
                    return Err(Unsupported(fallback.reason));
                }
                let first = parsed.into_iter().next();
                if first
                    .as_ref()
                    .is_some_and(|block| matches!(block.kind, SeedKind::Table { .. }))
                {
                    return Err(Unsupported("table in a toggle summary"));
                }
                let mut children = Vec::new();
                parse_masked(&body, &mut children, fallbacks)?;
                out.push(SeedBlock {
                    kind: SeedKind::Toggle { open },
                    content: first.map(|block| block.content).unwrap_or_default(),
                    children,
                });
            }
            toggles::Segment::Gap(count) => {
                out.extend((0..count).map(|_| SeedBlock::empty_paragraph()));
            }
            toggles::Segment::Markdown(text) => {
                for piece in prepare::split_preserving_blanks(&text) {
                    match piece {
                        prepare::Piece::Content(chunk) => {
                            markers::parse_content(&chunk, out, fallbacks);
                        }
                        prepare::Piece::Gap(count) => {
                            out.extend((0..count).map(|_| SeedBlock::empty_paragraph()));
                        }
                    }
                }
            }
        }
    }
    Ok(())
}

/// `restoreDetailsMarkup`, over every text run.
fn restore_details_markup(blocks: &mut [SeedBlock]) {
    for block in blocks {
        let cells = match &mut block.kind {
            SeedKind::Table { rows } => rows
                .iter_mut()
                .flat_map(|row| row.cells.iter_mut())
                .map(|cell| &mut cell.content)
                .collect(),
            _ => Vec::new(),
        };
        for content in cells.into_iter().chain([&mut block.content]) {
            for piece in content {
                if let SeedInline::Text { text, .. } = piece
                    && text.contains(toggles::DETAILS_LT_TOKEN)
                {
                    *text = text.replace(toggles::DETAILS_LT_TOKEN, "<");
                }
            }
        }
        restore_details_markup(&mut block.children);
    }
}

/// Seeds an **empty** body with the document `markdown` makes, in one write
/// the document's update sink sees, and returns what was kept as literal text.
///
/// A body that already holds anything is refused: seeding merges nothing, and
/// writing a second tree beside an existing one is the whole-fragment replace
/// chapter 12 §12.5.0.1 forbids.
pub fn seed_document(document: &Document, markdown: &str) -> Result<SeedPlan, CrdtError> {
    let plan = plan(markdown);
    document.write(|txn| {
        let fragment = txn
            .get_xml_fragment(BODY_FRAGMENT)
            .ok_or_else(|| refuse("the body fragment is missing"))?;
        if fragment.len(txn) > 0 {
            return Err(refuse("the body already has content"));
        }
        write::write_blocks(txn, &fragment, &plan.blocks, &mut random_block_id);
        Ok(())
    })??;
    Ok(plan)
}

/// Appends the blocks `markdown` makes after whatever the body already holds,
/// inside the caller's transaction: a filed inbox article under its link
/// mention (desktop's `generateNoteContent`, read by its editor).
///
/// Unlike [`seed_document`] the body need not be empty.
pub(crate) fn append_markdown_in(
    txn: &mut yrs::TransactionMut,
    markdown: &str,
) -> Result<SeedPlan, CrdtError> {
    let plan = plan(markdown);
    let group = crate::crdt::body_edit::top_block_group(txn)?;
    write::write_group(txn, &group, &plan.blocks, &mut random_block_id);
    Ok(plan)
}

/// Writes `blocks` into `group` from `index` on, each top-level block under
/// its id in `ids`, inside the caller's transaction: a paste
/// ([`crate::crdt::body_edit::BlockEdit::PasteMarkdown`]).
pub(crate) fn insert_blocks(
    txn: &mut yrs::TransactionMut,
    group: &yrs::XmlElementRef,
    index: u32,
    blocks: &[SeedBlock],
    ids: &[String],
) {
    write::insert_group(txn, group, index, blocks, ids, &mut random_block_id);
}

/// Whether a document's body fragment holds nothing at all: the condition
/// desktop seeds from markdown under (`crdt-provider.ts`, empty fragment).
pub fn body_is_empty(document: &Document) -> Result<bool, CrdtError> {
    document.read(|txn| {
        txn.get_xml_fragment(BODY_FRAGMENT)
            .is_none_or(|fragment| fragment.len(txn) == 0)
    })
}

fn refuse(what: &str) -> CrdtError {
    CrdtError::Undecodable {
        doc_id: BODY_FRAGMENT.to_owned(),
        what: format!("refusing to seed from markdown: {what}"),
    }
}

/// A random RFC 4122 v4 id, the shape `crypto.randomUUID()` gives BlockNote.
fn random_block_id() -> String {
    let mut bytes = crate::crypto::sodium::random_bytes(16);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex = hex::encode(bytes);
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

#[cfg(test)]
mod tests {
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
    fn raw_html_keeps_its_lines_as_literal_paragraphs() {
        let plan = plan("<kbd>Ctrl</kbd> raw\n\nafter");
        assert_eq!(plan.fallbacks[0].reason, "HTML");
        assert_eq!(plan.blocks[0], SeedBlock::literal("<kbd>Ctrl</kbd> raw"));
        assert_eq!(
            plan.blocks[1],
            SeedBlock::new(SeedKind::Paragraph, vec![text("after")])
        );
    }

    #[test]
    fn a_comment_desktop_would_leave_its_word_in_stays_literal_and_whole() {
        for (markdown, lines) in [
            ("$$\nx %% y %% z\n$$", vec!["$$", "x %% y %% z", "$$"]),
            (
                "![a %% b %% c](https://e.com/i.png)",
                vec!["![a %% b %% c](https://e.com/i.png)"],
            ),
            (
                "[a](https://e.com/%% b %%)",
                vec!["[a](https://e.com/%% b %%)"],
            ),
        ] {
            let plan = plan(markdown);
            assert_eq!(plan.fallbacks.len(), 1, "{markdown}");
            assert_eq!(plan.fallbacks[0].lines, lines, "{markdown}");
            assert!(
                !plan.blocks.iter().any(|block| {
                    block
                        .content
                        .iter()
                        .any(|piece| matches!(piece, SeedInline::HtmlComment { .. }))
                }),
                "{markdown}"
            );
        }
    }

    #[test]
    fn a_html_comment_across_lines_sends_the_whole_text_to_the_fallback() {
        let plan = plan("# a\n\n<!--\n# b\n-->\n\nc");
        assert_eq!(plan.fallbacks[0].reason, "HTML");
        assert_eq!(plan.blocks.len(), 5);
        let single = super::plan("# a\n\n<!-- b -->\n\nc");
        assert_eq!(single.blocks[0].kind, SeedKind::Heading { level: 1 });
    }
}
