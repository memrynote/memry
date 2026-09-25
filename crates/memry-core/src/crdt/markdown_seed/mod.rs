//! Markdown → BlockNote document seed (spec 005-journal JP022a).
//!
//! **Why the core parses markdown here, against chapter 12 §12.1.2.** A day
//! seeded from a template on the phone has only `seed_markdown` until an
//! editor turns it into a document, and the iOS app has no editor bundle to do
//! that (§5 fact c): the day would read "not on this phone", and the first
//! keystroke would write blocks into an empty document that desktop's next
//! write-back puts over the template text. So the core seeds the document
//! itself, for the block types templates use, and nothing more.
//!
//! **The document must be the one desktop would build** from the same bytes
//! (`apps/desktop/src/main/sync/blocknote-converter.ts` `markdownToYFragment`,
//! BlockNote 0.54's `markdownToHtml` and HTML parse, desktop's repairs around
//! them). Each stage is ported from its source, including its quirks: `1. `
//! on the last line is the paragraph `1.` because the text is `trim()`med
//! first; a soft break is one `hardBreak` and a hard break two; a code span
//! drops every other mark. `packages/contracts/test-vectors/markdown-seed.json`
//! pins the result, generated through the production parse path.
//!
//! **Supported**: paragraphs, headings 1–6 (ATX and setext), bullet, numbered
//! and check lists nested by indentation, quotes of one paragraph, fenced and
//! indented code blocks with their language, dividers, and inline bold,
//! italic, strike, code and links. Wiki links, tags and `{{…}}` tokens stay
//! plain text, which is what desktop's converter does with them too.
//!
//! **Fallback**: a construct outside that set (a table, HTML, an image or
//! embed, a callout, math, a structured quote, a task block, an inline
//! mention) keeps its block's source lines as literal text, one paragraph per
//! non-blank line, and is reported in [`SeedPlan::fallbacks`]. A construct
//! that changes how desktop reads the whole text (a toggle, CriticMarkup, a
//! link reference definition, a carriage return) sends every line there. No
//! text is dropped; the document then differs from desktop's in those blocks
//! only.

mod blocks;
mod inline;
mod links;
mod prepare;
mod shapes;
mod tokens;
mod write;

use yrs::{ReadTxn as _, XmlFragment as _};

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
    /// `None` is a code block with no language: BlockNote's default,
    /// `javascript`, is written.
    CodeBlock {
        language: Option<String>,
    },
    Divider,
}

/// One piece of inline content.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SeedInline {
    Text { text: String, marks: SeedMarks },
    HardBreak,
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

/// The blocks `markdown` seeds, without touching a document.
pub fn plan(markdown: &str) -> SeedPlan {
    if let Some(reason) = prepare::document_fallback(markdown) {
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

    let mut out = Vec::new();
    let mut fallbacks = Vec::new();
    if let Some((text, trailing_gap)) = prepare::toggle_segment(markdown) {
        for piece in prepare::split_preserving_blanks(&text) {
            match piece {
                prepare::Piece::Content(chunk) => {
                    blocks::parse_chunk(&chunk, &mut out, &mut fallbacks);
                }
                prepare::Piece::Gap(count) => {
                    out.extend((0..count).map(|_| SeedBlock::empty_paragraph()));
                }
            }
        }
        out.extend((0..trailing_gap).map(|_| SeedBlock::empty_paragraph()));
    }
    blocks::restore_untagged_fence_languages(markdown, &mut out);
    SeedPlan {
        blocks: out,
        fallbacks,
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
    fn a_table_keeps_its_lines_as_literal_paragraphs() {
        let plan = plan("## Log\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nafter");
        assert_eq!(plan.fallbacks.len(), 1);
        assert_eq!(plan.fallbacks[0].reason, "table");
        assert_eq!(plan.blocks[1], SeedBlock::literal("| a | b |"));
        assert_eq!(plan.blocks[3], SeedBlock::literal("| 1 | 2 |"));
        assert_eq!(
            plan.blocks[4],
            SeedBlock::new(SeedKind::Paragraph, vec![text("after")])
        );
    }

    #[test]
    fn a_toggle_sends_the_whole_document_to_the_fallback() {
        let plan = plan("# Title\n<details><summary>More</summary>\nbody\n</details>");
        assert_eq!(plan.fallbacks[0].reason, "toggle");
        assert_eq!(plan.blocks.len(), 4);
        assert_eq!(plan.blocks[0], SeedBlock::literal("# Title"));
    }

    #[test]
    fn an_image_in_a_list_sends_the_whole_list_item_to_the_fallback() {
        let plan = plan("- a\n  ![x](y.png)\n- b");
        assert_eq!(plan.fallbacks[0].reason, "image or embed");
        assert_eq!(plan.blocks[0], SeedBlock::literal("- a"));
        assert_eq!(plan.blocks[1], SeedBlock::literal("![x](y.png)"));
        assert_eq!(
            plan.blocks[2],
            SeedBlock::new(SeedKind::BulletListItem, vec![text("b")])
        );
    }
}
