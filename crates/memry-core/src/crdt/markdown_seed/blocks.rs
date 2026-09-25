//! Tokens to blocks: BlockNote's `tokensToHtml` and HTML parse, for the block
//! types this seed builds, plus the fallback for everything else.

use crate::domain::journal_rules::js_trim;

use super::inline::inline_content;
use super::prepare::{
    code_fence_info_strings, fence_indented_code, line_fallback, mask_hard_breaks,
    restore_hard_break_spelling,
};
use super::tokens::{ListType, Token, TokenKind, tokenize};
use super::{SeedBlock, SeedFallback, SeedInline, SeedKind, SeedMarks, Unsupported};

/// One content chunk: `parseContentWithMarkers` with nothing claimed, then
/// `parseMarkdownToBlocksRepaired`. A token that holds an unsupported
/// construct keeps its source lines as literal paragraphs.
pub(super) fn parse_chunk(
    chunk: &str,
    out: &mut Vec<SeedBlock>,
    fallbacks: &mut Vec<SeedFallback>,
) {
    if js_trim(chunk).is_empty() {
        return;
    }
    let fenced = fence_indented_code(chunk);
    let (masked, breaks) = mask_hard_breaks(&fenced);
    let lines: Vec<&str> = masked.split('\n').collect();
    let mut list = ListState::default();
    for token in tokenize(&masked) {
        let converted =
            check_lines(&token, &lines).and_then(|()| convert(&token, &breaks, &mut list));
        match converted {
            Ok(block) => out.push(block),
            Err(Unsupported(reason)) => {
                list = ListState::default();
                let kept: Vec<String> = lines[token.start..token.end.min(lines.len())]
                    .iter()
                    .map(|line| js_trim(&restore_hard_break_spelling(line, &breaks)).to_owned())
                    .filter(|line| !line.is_empty())
                    .collect();
                out.extend(kept.iter().map(|line| SeedBlock::literal(line)));
                fallbacks.push(SeedFallback {
                    reason,
                    lines: kept,
                });
            }
        }
    }
}

/// The line-level fallback, for every token but a code block (whose lines are
/// its literal content).
fn check_lines(token: &Token, lines: &[&str]) -> Result<(), Unsupported> {
    if matches!(token.kind, TokenKind::Code { .. }) {
        return Ok(());
    }
    for line in &lines[token.start..token.end.min(lines.len())] {
        if let Some(reason) = line_fallback(line) {
            return Err(Unsupported(reason));
        }
    }
    Ok(())
}

/// The list `emitListItems` has open: whether it is ordered.
#[derive(Debug, Default)]
struct ListState {
    open: Option<bool>,
}

fn convert_all(tokens: &[Token], breaks: &[String]) -> Result<Vec<SeedBlock>, Unsupported> {
    let mut list = ListState::default();
    tokens
        .iter()
        .map(|token| convert(token, breaks, &mut list))
        .collect()
}

fn convert(
    token: &Token,
    breaks: &[String],
    list: &mut ListState,
) -> Result<SeedBlock, Unsupported> {
    let TokenKind::ListItem {
        list: list_type,
        content,
        start,
        checked,
        child,
    } = &token.kind
    else {
        list.open = None;
        return convert_block(&token.kind, breaks);
    };

    let ordered = *list_type == ListType::Ordered;
    let opens = list.open != Some(ordered);
    list.open = Some(ordered);

    let child_tokens = child.as_deref().map(tokenize).unwrap_or_default();
    let nested_lists = child_tokens
        .iter()
        .filter(|token| matches!(token.kind, TokenKind::ListItem { .. }))
        .count();
    // BlockNote lifts a nested list out of its `li` (`nestedLists.ts`) and
    // turns every node after it into a sibling item of the outer list, which
    // moves text around; only all-list and list-free children keep their place.
    if nested_lists > 0 && nested_lists != child_tokens.len() {
        return Err(Unsupported("list item holding text and a list"));
    }

    let kind = match list_type {
        ListType::Bullet => SeedKind::BulletListItem,
        ListType::Task => SeedKind::CheckListItem { checked: *checked },
        ListType::Ordered => {
            let start = start.ok_or(Unsupported("list number"))?;
            let start = start.ok_or(Unsupported("list number"))?;
            // The item that opens an `<ol start>` carries it, unless a nested
            // list moved it into a wrapper `div`, which has no `start`
            // (`NumberedListItem` `parse`).
            SeedKind::NumberedListItem {
                start: (opens && start != 1 && nested_lists == 0).then_some(start),
            }
        }
    };
    let content = inline_content(content, breaks)?;
    // An empty `<p>` lets ProseMirror's fitting pull the first child up into
    // the item, or push it out beside it, depending on the item type.
    if content.is_empty() && nested_lists == 0 && !child_tokens.is_empty() {
        return Err(Unsupported("empty list item holding text"));
    }
    Ok(SeedBlock {
        kind,
        content,
        children: convert_all(&child_tokens, breaks)?,
    })
}

fn convert_block(kind: &TokenKind, breaks: &[String]) -> Result<SeedBlock, Unsupported> {
    let block = match kind {
        TokenKind::Heading { level, content } => SeedBlock::new(
            SeedKind::Heading { level: *level },
            inline_content(content, breaks)?,
        ),
        TokenKind::Paragraph { content } => {
            SeedBlock::new(SeedKind::Paragraph, inline_content(content, breaks)?)
        }
        TokenKind::Code { language, code } => {
            let content = if code.is_empty() {
                Vec::new()
            } else {
                vec![SeedInline::Text {
                    text: code.clone(),
                    marks: SeedMarks::default(),
                }]
            };
            let language = (!language.is_empty()).then(|| language.clone());
            SeedBlock::new(SeedKind::CodeBlock { language }, content)
        }
        // BlockNote's quote block holds one paragraph's inline content. A
        // quote holding anything else becomes a block with children on
        // desktop's structured-quote path, which this seed does not build.
        TokenKind::Quote { content } => match tokenize(content).as_slice() {
            [] => SeedBlock::new(SeedKind::Quote, Vec::new()),
            [
                Token {
                    kind: TokenKind::Paragraph { content },
                    ..
                },
            ] => SeedBlock::new(SeedKind::Quote, inline_content(content, breaks)?),
            _ => return Err(Unsupported("structured quote")),
        },
        TokenKind::Rule => SeedBlock::new(SeedKind::Divider, Vec::new()),
        TokenKind::Table => return Err(Unsupported("table")),
        TokenKind::RawHtml => return Err(Unsupported("HTML")),
        // `convert` builds list items, with the list state they need.
        TokenKind::ListItem { .. } => return Err(Unsupported("list item")),
    };
    Ok(block)
}

/// `restoreUntaggedFenceLanguages` (`blocknote-converter.ts`): when every
/// fence in the source became a code block, a fence that carried no language
/// gets `""` instead of BlockNote's invented default.
pub(super) fn restore_untagged_fence_languages(markdown: &str, blocks: &mut [SeedBlock]) {
    let infos = code_fence_info_strings(markdown);
    if !infos.iter().any(String::is_empty) {
        return;
    }
    if count_code_blocks(blocks) != infos.len() {
        return;
    }
    clear_untagged(blocks, &infos, &mut 0);
}

/// Code blocks in document order: a block, then its children.
fn count_code_blocks(blocks: &[SeedBlock]) -> usize {
    blocks
        .iter()
        .map(|block| {
            usize::from(matches!(block.kind, SeedKind::CodeBlock { .. }))
                + count_code_blocks(&block.children)
        })
        .sum()
}

fn clear_untagged(blocks: &mut [SeedBlock], infos: &[String], next: &mut usize) {
    for block in blocks {
        if matches!(block.kind, SeedKind::CodeBlock { .. }) {
            if infos.get(*next).is_some_and(String::is_empty) {
                block.kind = SeedKind::CodeBlock {
                    language: Some(String::new()),
                };
            }
            *next += 1;
        }
        clear_untagged(&mut block.children, infos, next);
    }
}
