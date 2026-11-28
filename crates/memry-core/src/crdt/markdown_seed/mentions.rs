//! `((mention:…))` and `((date:…))` tokens through the seed: hidden from the
//! parser (`editor-schema/src/inline/token-masking.ts`), put back in every
//! run, and made nodes once the blocks exist (`prepareFragmentSeed`'s
//! promotion, chapter 12 §12.1.1.1; [`crate::crdt::inline_tokens`]).
//!
//! The parser would read a payload's underscores as emphasis, so each token
//! travels as a word of letters and digits. Desktop numbers its placeholders;
//! this one carries the token's bytes in hex, as the comment mask does, so
//! nothing has to carry a table from the mask to the restore. Both are words
//! to the parser.

use std::sync::LazyLock;

use crate::crdt::inline_tokens::{self, Piece};

use super::markers::FenceTracker;
use super::mask_word::mask_word;
use super::{SeedBlock, SeedInline, SeedKind, SeedMarks};

fn prefix() -> &'static str {
    static PREFIX: LazyLock<String> = LazyLock::new(|| format!("MEMRYTKN{}", mask_word()));
    &PREFIX
}

pub(super) fn holds_placeholder(text: &str) -> bool {
    text.contains(prefix())
}

/// `INLINE_TOKEN_REGEX`, `/\(\((?:mention|date):[^()\n\r]*\)\)/g`: each
/// match's start and end in `line`.
fn tokens(line: &str) -> Vec<(usize, usize)> {
    let mut found = Vec::new();
    let mut from = 0;
    while let Some(at) = line[from..].find("((") {
        let start = from + at;
        let rest = &line[start + 2..];
        let open = ["mention:", "date:"]
            .into_iter()
            .find(|kind| rest.starts_with(kind))
            .map(str::len);
        if let Some(open) = open {
            let payload = &rest[open..];
            let length = payload
                .find(['(', ')', '\n', '\r'])
                .unwrap_or(payload.len());
            if payload[length..].starts_with("))") {
                let end = start + 2 + open + length + 2;
                found.push((start, end));
                from = end;
                continue;
            }
        }
        from = start + 1;
    }
    found
}

/// `STRAY_ESCAPE`, `/\\([!-/:-@[-`{-~])/g`: a backslash before ASCII
/// punctuation inside a token is an escaper's damage, which the parse would
/// have healed.
fn healed(token: &str) -> String {
    let mut out = String::with_capacity(token.len());
    let mut chars = token.chars().peekable();
    while let Some(c) = chars.next() {
        match chars.peek() {
            Some(next) if c == '\\' && next.is_ascii_punctuation() => {
                out.push(*next);
                chars.next();
            }
            _ => out.push(c),
        }
    }
    out
}

/// `maskInlineTokens`: every token outside a code fence as desktop's numbered
/// placeholder (`MEMRYTKN<word><index>X`), and the tokens, healed, by index.
/// The raw-HTML scan runs on this text, as desktop's does, so a tag holding a
/// token is as long to it as it is to desktop. [`hexify`] makes the placeholders
/// the rest of the seed reads.
pub(super) fn mask_numbered(markdown: &str) -> (String, Vec<String>) {
    if !markdown.contains("((") {
        return (markdown.to_owned(), Vec::new());
    }
    let mut fence = FenceTracker::default();
    let mut found = Vec::new();
    let lines: Vec<String> = markdown
        .split('\n')
        .map(|line| {
            if fence.consume(line) {
                return line.to_owned();
            }
            let mut out = String::with_capacity(line.len());
            let mut last = 0;
            for (start, end) in tokens(line) {
                out.push_str(&line[last..start]);
                out.push_str(&format!("{}{}X", prefix(), found.len()));
                found.push(healed(&line[start..end]));
                last = end;
            }
            out.push_str(&line[last..]);
            out
        })
        .collect();
    (lines.join("\n"), found)
}

/// `text` with each numbered placeholder `tokens` holds written as the
/// placeholder that carries its token's bytes in hex, which needs no table to
/// put back ([`restore`]). One a token does not hold stays as it is.
pub(super) fn hexify(text: &str, tokens: &[String]) -> String {
    if tokens.is_empty() || !holds_placeholder(text) {
        return text.to_owned();
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find(prefix()) {
        out.push_str(&rest[..at]);
        let digits = &rest[at + prefix().len()..];
        let length = digits.bytes().take_while(u8::is_ascii_digit).count();
        let token = digits[length..]
            .starts_with('X')
            .then(|| digits[..length].parse::<usize>().ok())
            .flatten()
            .and_then(|index| tokens.get(index));
        match token {
            Some(token) => {
                out.push_str(&format!("{}{}X", prefix(), hex::encode(token)));
                rest = &digits[length + 1..];
            }
            None => {
                out.push_str(prefix());
                rest = digits;
            }
        }
    }
    out.push_str(rest);
    out
}

/// `restoreInlineTokens`: every placeholder back to its token.
pub(super) fn restore(text: &str) -> String {
    if !holds_placeholder(text) {
        return text.to_owned();
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find(prefix()) {
        out.push_str(&rest[..at]);
        let digits = &rest[at + prefix().len()..];
        let hex_len = digits
            .bytes()
            .take_while(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
            .count();
        let decoded = digits[hex_len..]
            .starts_with('X')
            .then(|| hex::decode(&digits[..hex_len]).ok())
            .flatten()
            .and_then(|bytes| String::from_utf8(bytes).ok());
        match decoded {
            Some(token) => {
                out.push_str(&token);
                rest = &digits[hex_len + 1..];
            }
            None => {
                out.push_str(prefix());
                rest = digits;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Whether `line` holds a token whose node this port cannot decide: its
/// block keeps its source lines as text rather than guess.
pub(super) fn undecided(line: &str) -> bool {
    tokens(line)
        .into_iter()
        .any(|(start, end)| inline_tokens::holds_undecided(&healed(&line[start..end])))
}

/// `normalizeLinkMentions` and its date twin over the seeded blocks: each
/// token in an unstyled run of any block but a code block becomes its node.
pub(super) fn promote(blocks: &mut [SeedBlock]) {
    for block in blocks {
        match &mut block.kind {
            SeedKind::CodeBlock { .. } | SeedKind::Diagram => {}
            SeedKind::Table { rows } => {
                for cell in rows.iter_mut().flat_map(|row| row.cells.iter_mut()) {
                    promote_content(&mut cell.content);
                }
            }
            _ => promote_content(&mut block.content),
        }
        promote(&mut block.children);
    }
}

fn promote_content(content: &mut Vec<SeedInline>) {
    let unstyled = SeedMarks::default();
    if !content
        .iter()
        .any(|piece| matches!(piece, SeedInline::Text { text, marks } if *marks == unstyled && text.contains("((")))
    {
        return;
    }
    let mut out = Vec::with_capacity(content.len());
    for piece in content.drain(..) {
        let pieces = match &piece {
            SeedInline::Text { text, marks } if *marks == unstyled => inline_tokens::split(text),
            _ => None,
        };
        let Some(pieces) = pieces else {
            out.push(piece);
            continue;
        };
        out.extend(pieces.into_iter().map(|piece| match piece {
            Piece::Text(text) => SeedInline::Text {
                text: text.to_owned(),
                marks: SeedMarks::default(),
            },
            Piece::Node(node) => SeedInline::Token(node),
        }));
    }
    *content = out;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_token_outside_a_fence_round_trips_through_its_placeholders() {
        let (masked, tokens) = mask_numbered("a ((date:x_y\\_z)) b\n```\n((date:q))\n```");
        assert!(!masked.contains("((date:x"));
        assert!(masked.contains("```\n((date:q))\n```"));
        assert_eq!(tokens, ["((date:x_y_z))"]);
        assert!(masked.contains(&format!("{}0X", prefix())));
        let hex = hexify(&masked, &tokens);
        assert!(!hex.contains(&format!("{}0X", prefix())));
        assert_eq!(restore(&hex), "a ((date:x_y_z)) b\n```\n((date:q))\n```");
        let (masked, tokens) = mask_numbered("((mention:a(b)) ((mention:c))");
        assert_eq!(masked, format!("((mention:a(b)) {}0X", prefix()));
        assert_eq!(tokens, ["((mention:c))"]);
    }

    #[test]
    fn a_placeholder_no_token_holds_stays_as_it_is() {
        let text = format!("{}7X {}x", prefix(), prefix());
        assert_eq!(hexify(&text, &["((date:a))".to_owned()]), text);
    }
}
