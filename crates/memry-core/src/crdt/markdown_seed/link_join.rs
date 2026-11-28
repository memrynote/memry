//! Whether a list item's line joins the lines below it over link text:
//! `endsInsideLinkText`, `linkParagraphReader` and `addressKeepsSplit` of
//! `shared/hard-breaks.ts`.
//!
//! Each line is read once: the line that ends inside link text on its own, and
//! the rest of its paragraph once per paragraph ([`LinkParagraphs`]), however
//! many of the paragraph's lines ask.

use crate::domain::journal_rules::is_js_whitespace;

use super::hard_breaks::{block_start, hard_break_spelling, is_blank, is_inline_space, seen};

/// What [`LinkParagraphs::ends_inside_link_text`] read of the paragraph that
/// runs from some line up to `end`, a blank line or a block start.
#[derive(Default)]
pub(super) struct LinkParagraphs {
    /// The `at` of the last call, which the next may not go below.
    asked: usize,
    end: usize,
    /// The paragraph's last line holds an address.
    closes: bool,
    /// The paragraph's last line that keeps the split on its own.
    last_keeping_split: Option<usize>,
}

impl LinkParagraphs {
    /// `endsInsideLinkText`: when `line` ends inside link text that the last
    /// line of its paragraph closes, how many lines from `lines[at]` on that
    /// paragraph holds. An image, a code span, an escaped bracket, a link
    /// title, an address the writer cannot spell back ([`address_keeps_split`]),
    /// a tag other than `<br>`, a `<br>` against a line end or a hard break on a
    /// later line keeps the old split. `depth` is how many `[` the line leaves
    /// open.
    ///
    /// `at` only grows from call to call, and the lines from `at` on are as
    /// the source wrote them.
    pub(super) fn ends_inside_link_text(
        &mut self,
        depth: usize,
        line: &str,
        lines: &[String],
        at: usize,
    ) -> Option<usize> {
        debug_assert!(
            at >= self.asked,
            "asked at line {at} after line {}: the paragraph read is stale",
            self.asked
        );
        self.asked = at;
        // The depth test only reads `line`, and the rest only refuses, so asking
        // it first keeps a long lazy paragraph from being read at all.
        if depth == 0 {
            return None;
        }
        if at >= self.end {
            self.read(lines, at);
        }
        let joins = self.end > at
            && self.closes
            && self.last_keeping_split.is_none_or(|index| index < at)
            && !line_keeps_split(&seen(line));
        joins.then_some(self.end - at)
    }

    /// Reads the paragraph that starts at `lines[at]`.
    fn read(&mut self, lines: &[String], at: usize) {
        self.end = at
            + lines[at..]
                .iter()
                .position(|next| is_blank(next) || block_start(next))
                .unwrap_or(lines.len() - at);
        self.closes = self.end > at && lines[self.end - 1].contains("](");
        self.last_keeping_split = (at..self.end).rev().find(|&index| {
            let last = index + 1 == self.end;
            let line = seen(&lines[index]);
            line.contains(['`', '<'])
                || line.contains("![")
                || line.contains("\\[")
                || line.contains("\\]")
                || address_keeps_split(&line, last)
                || (!last && hard_break_spelling(&lines[index]).is_some())
        });
    }
}

/// `/<br>/i` at the start of `chars`.
fn is_br_tag(chars: &[char]) -> bool {
    chars.len() >= 4
        && chars[0] == '<'
        && chars[1].eq_ignore_ascii_case(&'b')
        && chars[2].eq_ignore_ascii_case(&'r')
        && chars[3] == '>'
}

/// `/`|<(?!br>)|!\[|\\[[\]]|<br>[^\S\n]*$/i` on a line that more lines
/// follow, or an address in it that keeps the split.
fn line_keeps_split(line: &str) -> bool {
    let chars: Vec<char> = line.chars().collect();
    let blocks = chars.iter().enumerate().any(|(i, c)| match c {
        '`' => true,
        '<' if !is_br_tag(&chars[i..]) => true,
        '<' => chars[i + 4..].iter().all(|c| is_inline_space(*c)),
        '!' => chars.get(i + 1) == Some(&'['),
        '\\' => matches!(chars.get(i + 1), Some('[' | ']')),
        _ => false,
    });
    blocks || address_keeps_split(line, false)
}

/// `addressKeepsSplit`: true when an address in `line` holds a title or a
/// space, or holds a parenthesis that is unbalanced or next to a backslash,
/// which the writer escapes again on every save (BBF-107). Unless `last` ends
/// the paragraph, the line ends in a newline, which no address can hold.
///
/// An address that starts inside one already read and closed is not read: it
/// closes inside that one, so whatever it holds the outer one holds too.
fn address_keeps_split(line: &str, last: bool) -> bool {
    let mut read = 0;
    for (open, _) in line.match_indices("](") {
        if open + 1 < read {
            continue;
        }
        let mut depth = 0i64;
        let (mut paren, mut backslash) = (false, false);
        let mut close = None;
        for (offset, c) in line[open + 2..].char_indices() {
            if is_js_whitespace(c) {
                return true;
            }
            match c {
                '\\' => backslash = true,
                '(' => {
                    paren = true;
                    depth += 1;
                }
                ')' => {
                    depth -= 1;
                    if depth < 0 {
                        close = Some(open + 2 + offset);
                        break;
                    }
                }
                _ => {}
            }
        }
        match close {
            None if !last || paren => return true,
            Some(_) if paren && backslash => return true,
            None => read = line.len(),
            Some(close) => read = close,
        }
    }
    false
}
