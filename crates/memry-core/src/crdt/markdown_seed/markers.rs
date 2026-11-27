//! `parseContentWithMarkers` (`blocknote-converter.ts`): the lines of one
//! content piece, read one at a time. A line that opens a construct desktop
//! claims outside BlockNote's parser becomes its block; the lines between go
//! to the parser in one run ([`super::blocks::parse_chunk`]).

use crate::domain::journal_rules::js_trim;

use super::block_starts::opens_block;
use super::blocks::parse_chunk;
use super::claims::{Claim, callout_at, math_at, quote_at};
use super::comment_nodes::{has_token, source_lines};
use super::media::marker_line;
use super::prepare::fence_line;
use super::{SeedBlock, SeedFallback, SeedKind, Unsupported};

pub(super) fn parse_content(
    text: &str,
    out: &mut Vec<SeedBlock>,
    fallbacks: &mut Vec<SeedFallback>,
) {
    let mut buffer: Vec<&str> = Vec::new();
    let mut fence = FenceTracker::default();
    let flush =
        |buffer: &mut Vec<&str>, out: &mut Vec<SeedBlock>, fallbacks: &mut Vec<SeedFallback>| {
            if !buffer.is_empty() {
                parse_chunk(&buffer.join("\n"), out, fallbacks);
                buffer.clear();
            }
        };
    let lines: Vec<&str> = text.split('\n').collect();
    let mut index = 0;
    while index < lines.len() {
        let line = lines[index];
        let inside_fence = fence.consume(line);
        if !inside_fence {
            let at_paragraph_start = index == 0 || js_trim(lines[index - 1]).is_empty();
            // A claim also stands where BlockNote opens a block of its own
            // (`block_starts`): the canonical form's blank line makes a
            // paragraph start of it on the next seed. A bare `[!info]` still
            // wants one: under text it is that text.
            let at_block_start =
                at_paragraph_start || opens_block(&lines, index, index - buffer.len());
            let claimed = claim_at(&lines, index, at_paragraph_start, at_block_start);
            if !matches!(claimed, Ok(None)) {
                flush(&mut buffer, out, fallbacks);
            }
            match claimed {
                Ok(Some((block, end))) => {
                    out.push(block);
                    for consumed in &lines[index + 1..end] {
                        fence.consume(consumed);
                    }
                    index = end;
                    continue;
                }
                Ok(None) => {}
                Err((Unsupported(reason), end)) => {
                    let kept: Vec<String> = lines[index..end]
                        .iter()
                        .flat_map(|line| source_lines(line))
                        .collect();
                    out.extend(kept.iter().map(|line| SeedBlock::literal(line)));
                    fallbacks.push(SeedFallback {
                        reason,
                        lines: kept,
                    });
                    for consumed in &lines[index + 1..end] {
                        fence.consume(consumed);
                    }
                    index = end;
                    continue;
                }
            }
        }
        buffer.push(line);
        index += 1;
    }
    flush(&mut buffer, out, fallbacks);
}

/// What desktop claims at `lines[index]`, in its order: a callout, a math
/// block, a structured quote, then a one-line marker. An unsupported claim
/// carries the index its run ends at; its lines stay literal. A quoted callout,
/// a quote and a math block want a block start; a bare callout a paragraph's.
fn claim_at(
    lines: &[&str],
    index: usize,
    at_paragraph_start: bool,
    at_block_start: bool,
) -> Result<Option<Claim>, (Unsupported, usize)> {
    let run_end = || {
        let mut end = index + 1;
        while lines.get(end).is_some_and(|line| !js_trim(line).is_empty()) {
            end += 1;
        }
        end
    };
    if let Some(claim) = callout_at(
        lines,
        index,
        if lines[index].starts_with('>') {
            at_block_start
        } else {
            at_paragraph_start
        },
    )
    .map_err(|e| (e, run_end()))?
    {
        return Ok(Some(claim));
    }
    if let Some(claim) = math_at(lines, index, at_block_start) {
        // Desktop keeps the masked word in the formula, a random one.
        if matches!(&claim.0.kind, SeedKind::Math { latex } if has_token(latex)) {
            return Err((Unsupported("comment in a math block"), claim.1));
        }
        return Ok(Some(claim));
    }
    if at_block_start && let Some(claim) = quote_at(lines, index).map_err(|e| (e, run_end()))? {
        return Ok(Some(claim));
    }
    match marker_line(lines[index]) {
        // The marker's props would hold desktop's masked word.
        Ok(Some(_)) if has_token(lines[index]) => {
            Err((Unsupported("comment in a marker line"), index + 1))
        }
        Ok(found) => Ok(found.map(|block| (block, index + 1))),
        Err(unsupported) => Err((unsupported, index + 1)),
    }
}

/// `createFenceTracker` (`shared/markdown-fences.ts`).
#[derive(Debug, Default)]
pub(super) struct FenceTracker {
    open: Option<(char, usize)>,
}

impl FenceTracker {
    /// Whether `line` is inside a fence, its opening and closing lines
    /// included.
    pub(super) fn consume(&mut self, line: &str) -> bool {
        let Some((fence_char, length, rest)) = fence_line(line) else {
            return self.open.is_some();
        };
        match self.open {
            None => {
                if fence_char == '`' && rest.contains('`') {
                    return false;
                }
                self.open = Some((fence_char, length));
            }
            Some((open_char, open_length)) => {
                if fence_char == open_char && length >= open_length && js_trim(rest).is_empty() {
                    self.open = None;
                }
            }
        }
        true
    }
}
