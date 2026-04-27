//! Markdown to a narrow BlockNote-compatible block list.
//!
//! Scope for M5 first-open seeding: paragraphs, headings, list items, and code
//! blocks. Rich inline marks and complex block types are intentionally flattened.

use pulldown_cmark::{CodeBlockKind, Event, HeadingLevel, Parser, Tag, TagEnd};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlockNoteBlock {
    pub kind: String,
    pub text: String,
    pub level: Option<u8>,
    pub language: Option<String>,
}

#[derive(Debug, Clone)]
struct ActiveBlock {
    kind: &'static str,
    text: String,
    level: Option<u8>,
    language: Option<String>,
}

pub fn md_to_blocknote_blocks(input: &str) -> Vec<BlockNoteBlock> {
    if input.trim().is_empty() {
        return vec![empty_paragraph()];
    }

    let mut blocks = Vec::new();
    let mut active: Option<ActiveBlock> = None;
    let mut list_stack: Vec<&'static str> = Vec::new();

    for event in Parser::new(input) {
        match event {
            Event::Start(tag) => match tag {
                Tag::Paragraph => {
                    if active.is_none() {
                        start_block(
                            &mut active,
                            list_stack.last().copied().unwrap_or("paragraph"),
                            None,
                            None,
                        );
                    }
                }
                Tag::Heading { level, .. } => {
                    start_block(&mut active, "heading", Some(heading_level(level)), None);
                }
                Tag::CodeBlock(kind) => {
                    let language = match kind {
                        CodeBlockKind::Fenced(value) if !value.is_empty() => {
                            Some(value.to_string())
                        }
                        _ => None,
                    };
                    start_block(&mut active, "codeBlock", None, language);
                }
                Tag::List(Some(_)) => list_stack.push("numberedListItem"),
                Tag::List(None) => list_stack.push("bulletListItem"),
                Tag::Item => {
                    if let Some(kind) = list_stack.last().copied() {
                        start_block(&mut active, kind, None, None);
                    }
                }
                _ => {}
            },
            Event::End(tag) => match tag {
                TagEnd::Paragraph | TagEnd::Heading(_) | TagEnd::CodeBlock => {
                    finish_block(&mut blocks, &mut active);
                }
                TagEnd::Item => {
                    finish_block(&mut blocks, &mut active);
                }
                TagEnd::List(_) => {
                    list_stack.pop();
                }
                _ => {}
            },
            Event::Text(text) => {
                if active.is_none() {
                    start_block(&mut active, "paragraph", None, None);
                }
                if let Some(block) = active.as_mut() {
                    block.text.push_str(&text);
                }
            }
            Event::Code(code) => {
                if active.is_none() {
                    start_block(&mut active, "paragraph", None, None);
                }
                if let Some(block) = active.as_mut() {
                    block.text.push_str(&code);
                }
            }
            Event::SoftBreak | Event::HardBreak => {
                if let Some(block) = active.as_mut() {
                    block.text.push('\n');
                }
            }
            _ => {}
        }
    }

    finish_block(&mut blocks, &mut active);

    if blocks.is_empty() {
        vec![BlockNoteBlock {
            kind: "paragraph".to_string(),
            text: input.to_string(),
            level: None,
            language: None,
        }]
    } else {
        blocks
    }
}

fn start_block(
    active: &mut Option<ActiveBlock>,
    kind: &'static str,
    level: Option<u8>,
    language: Option<String>,
) {
    if active.is_some() {
        return;
    }
    *active = Some(ActiveBlock {
        kind,
        text: String::new(),
        level,
        language,
    });
}

fn finish_block(blocks: &mut Vec<BlockNoteBlock>, active: &mut Option<ActiveBlock>) {
    let Some(block) = active.take() else {
        return;
    };
    if block.text.is_empty() && block.kind != "codeBlock" {
        return;
    }
    blocks.push(BlockNoteBlock {
        kind: block.kind.to_string(),
        text: block.text,
        level: block.level,
        language: block.language,
    });
}

fn empty_paragraph() -> BlockNoteBlock {
    BlockNoteBlock {
        kind: "paragraph".to_string(),
        text: String::new(),
        level: None,
        language: None,
    }
}

fn heading_level(level: HeadingLevel) -> u8 {
    match level {
        HeadingLevel::H1 => 1,
        HeadingLevel::H2 => 2,
        HeadingLevel::H3 => 3,
        HeadingLevel::H4 => 4,
        HeadingLevel::H5 => 5,
        HeadingLevel::H6 => 6,
    }
}
