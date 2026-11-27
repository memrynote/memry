//! Tokens to blocks: BlockNote's `tokensToHtml` and HTML parse, for the block
//! types this seed builds, plus the fallback for everything else.

use crate::domain::journal_rules::js_trim;

use crate::domain::journal_rules::is_js_whitespace;

use super::code_spans::keep_code_whitespace;
use super::comment_nodes::{into_nodes, source_lines};
use super::comments;
use super::emphasis_edges::trim_blocks;
use super::empty_blocks::{
    drop_empty_block_placeholders, leaks_placeholder, mask_empty_block_lines,
};
use super::hard_breaks::{JOIN, mask_hard_breaks, restore_hard_break_spelling};
use super::inline::{Html, holds_media, inline_content};
use super::lift::lift_images;
use super::media::media_block;
use super::prepare::{fence_indented_code, line_fallback};
use super::runs::block_content;
use super::table::{escape_wiki_link_pipes_in_table_rows, table_block};
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
    // `parseMarkdownToBlocksRepaired` masks its own text again: a chunk is
    // trimmed and cut from the lines around it, so what it holds can differ.
    let chunk = comments::mask(chunk).text;
    let first_block = out.len();
    let first_fallback = fallbacks.len();
    let fenced = fence_indented_code(&escape_wiki_link_pipes_in_table_rows(&chunk));
    let (masked, breaks) = mask_hard_breaks(&fenced);
    let lines: Vec<&str> = masked.split('\n').collect();
    let mut list = ListState::default();
    // The parser holds a placeholder on each empty item or heading line; the
    // source lines a fallback keeps are the ones without it.
    for token in tokenize(&mask_empty_block_lines(&masked)) {
        let converted = check_lines(&token, &lines).and_then(|()| match &token.kind {
            TokenKind::Paragraph { content } => {
                list = ListState::default();
                text_block(SeedKind::Paragraph, content, &breaks)
            }
            TokenKind::Heading { level, content } => {
                list = ListState::default();
                text_block(SeedKind::Heading { level: *level }, content, &breaks)
            }
            _ => convert(&token, &breaks, &mut list).map(|block| vec![block]),
        });
        match converted {
            Ok(blocks) => out.extend(blocks),
            Err(Unsupported(reason)) => {
                list = ListState::default();
                // A list-item join is a line split again here: one literal
                // paragraph per source line.
                let kept = source_text(&lines[token.start..token.end.min(lines.len())], &breaks);
                out.extend(kept.iter().map(|line| SeedBlock::literal(line)));
                fallbacks.push(SeedFallback {
                    reason,
                    lines: kept,
                });
            }
        }
    }
    drop_empty_block_placeholders(&mut out[first_block..]);
    if leaks_placeholder(&out[first_block..]) {
        out.truncate(first_block);
        fallbacks.truncate(first_fallback);
        let kept = source_text(&lines, &breaks);
        out.extend(kept.iter().map(|line| SeedBlock::literal(line)));
        fallbacks.push(SeedFallback {
            reason: "empty item or heading inside a paragraph",
            lines: kept,
        });
    }
    into_nodes(&mut out[first_block..]);
    trim_blocks(&mut out[first_block..]);
}

/// The source lines of masked `lines`, hard-break spelling restored: a
/// list-item join is a line split again, one literal paragraph per line.
fn source_text(lines: &[&str], breaks: &[String]) -> Vec<String> {
    lines
        .iter()
        .flat_map(|line| {
            restore_hard_break_spelling(line, breaks)
                .split(JOIN)
                .flat_map(source_lines)
                .collect::<Vec<_>>()
        })
        .collect()
}

/// A top-level paragraph or heading, and the media blocks its images become:
/// `liftImagesOutOfTextBlocks` moves an image out of the text, and a
/// paragraph of nothing but images and videos parses to their blocks.
fn text_block(
    kind: SeedKind,
    content: &str,
    breaks: &[String],
) -> Result<Vec<SeedBlock>, Unsupported> {
    let html = super::inline::parse(&keep_code_whitespace(content))?;
    let paragraph = kind == SeedKind::Paragraph;
    if !holds_media(&html) {
        return Ok(vec![SeedBlock::new(
            kind,
            block_content(html, breaks, paragraph),
        )]);
    }
    let lift_when_alone = kind != SeedKind::Paragraph;
    if let Some((text, media)) = lift_images(&html, lift_when_alone) {
        if holds_media(&text) {
            // A video beside text, which desktop's parse drops.
            return Err(Unsupported("video beside text"));
        }
        let mut blocks = vec![SeedBlock::new(kind, block_content(text, breaks, paragraph))];
        for found in &media {
            blocks.push(media_block(found, breaks)?);
        }
        return Ok(blocks);
    }
    let mut media = Vec::new();
    if lift_when_alone || !media_only(&html, &mut media) {
        return Err(Unsupported("media beside text"));
    }
    media
        .into_iter()
        .map(|found| media_block(found, breaks))
        .collect()
}

/// Whether `nodes` hold only images, videos and whitespace, collecting the
/// media in order.
fn media_only<'a>(nodes: &'a [Html], media: &mut Vec<&'a super::media::Media>) -> bool {
    nodes.iter().all(|node| match node {
        Html::Media(found) => {
            media.push(found);
            true
        }
        Html::Text(text) => text.chars().all(is_js_whitespace) && !text.contains('\n'),
        Html::Wrap(_, children) | Html::Link { children, .. } => media_only(children, media),
        Html::Br | Html::Code(_) => false,
    })
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
    let content = inline_content(content, breaks, false)?;
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
            inline_content(content, breaks, false)?,
        ),
        TokenKind::Paragraph { content } => {
            SeedBlock::new(SeedKind::Paragraph, inline_content(content, breaks, true)?)
        }
        TokenKind::Code { language, code } => {
            // A token in a fence the mask did not see as one (a fence another
            // fence's opener closed) gets its spelling back: the bytes of a
            // code block are literal (`repairRuns`, `unmaskRun`), and so do
            // its string props, the language among them (`repairBlocks`).
            // A join inside such a fence is the `<br>` desktop writes there
            // (`repairRuns` restores the token only), so it is one here.
            let code = restore_hard_break_spelling(code, breaks).replace(JOIN, "<br>");
            let language = restore_hard_break_spelling(language, breaks);
            let content = if code.is_empty() {
                Vec::new()
            } else {
                vec![SeedInline::Text {
                    text: code,
                    marks: SeedMarks::default(),
                }]
            };
            // The diagram block claims a `<pre><code>` whose language is
            // `mermaid` (`server-specs.ts` `parseDiagramCodeElement`).
            let kind = if language == "mermaid" {
                SeedKind::Diagram
            } else {
                SeedKind::CodeBlock { language }
            };
            SeedBlock::new(kind, content)
        }
        // BlockNote's quote block holds one paragraph's inline content. A
        // quote with a blank `>` line is claimed before the parser
        // (`claims::quote_at`); one that claim declines reaches BlockNote's
        // flat quote, which this seed does not build.
        TokenKind::Quote { content } => match tokenize(content).as_slice() {
            [] => SeedBlock::new(SeedKind::Quote, Vec::new()),
            [
                Token {
                    kind: TokenKind::Paragraph { content },
                    ..
                },
            ] => SeedBlock::new(SeedKind::Quote, inline_content(content, breaks, false)?),
            _ => return Err(Unsupported("structured quote")),
        },
        TokenKind::Rule => SeedBlock::new(SeedKind::Divider, Vec::new()),
        TokenKind::Table { header, rows } => table_block(header, rows, breaks)?,
        TokenKind::RawHtml => return Err(Unsupported("HTML")),
        // `convert` builds list items, with the list state they need.
        TokenKind::ListItem { .. } => return Err(Unsupported("list item")),
    };
    Ok(block)
}
