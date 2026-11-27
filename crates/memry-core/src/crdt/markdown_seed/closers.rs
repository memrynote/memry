//! The forward scans of `parseInline`, answered from one pass over the text.
//!
//! `findClosingBracket`, `findClosingParen` and `parseDelimited` each scan
//! from an opener towards the end of the text. Run from every opener of a
//! long run no closer matches (`![a](` or `*a ` repeated) that is one scan
//! to the end per opener, seconds for a pasted blob of a few hundred
//! kilobytes. Each scan steps over a backslash and the character after it,
//! and from any position after a non-backslash character that pairing is
//! the one a single pass from the start of the text makes. So one pass per
//! bracket pair, and one per delimiter, answers every scan the same way.

use std::collections::HashMap;

use super::backtick_runs::BacktickRuns;

pub(super) struct Closers<'t> {
    text: &'t [char],
    /// How many spans enclose `text`.
    depth: usize,
    /// Whether each character is the second of a backslash pair.
    escaped: Option<Vec<bool>>,
    /// By opening character: the closer that brings each opener's depth
    /// back to zero.
    matches: HashMap<char, Vec<Option<usize>>>,
    /// By delimiter character and length: the first closer at or after each
    /// position, `text.len()` when there is none.
    delimiters: HashMap<(char, usize), Vec<usize>>,
    /// The code span closers, found on the first backtick.
    ticks: Option<BacktickRuns>,
}

impl<'t> Closers<'t> {
    pub(super) fn new(text: &'t [char], depth: usize) -> Self {
        Self {
            text,
            depth,
            escaped: None,
            matches: HashMap::new(),
            delimiters: HashMap::new(),
            ticks: None,
        }
    }

    pub(super) fn depth(&self) -> usize {
        self.depth
    }

    pub(super) fn text(&self) -> &'t [char] {
        self.text
    }

    fn escaped(&mut self) -> &[bool] {
        let text = self.text;
        self.escaped.get_or_insert_with(|| {
            let mut escaped = vec![false; text.len()];
            let mut i = 0;
            while i < text.len() {
                if text[i] == '\\' && i + 1 < text.len() {
                    escaped[i + 1] = true;
                    i += 2;
                } else {
                    i += 1;
                }
            }
            escaped
        })
    }

    /// `findClosingBracket` / `findClosingParen` from the `open` at
    /// `open_at`: the first `close` past it at depth zero. `parseInline`
    /// reaches an opener only where the pairing has not escaped it, which is
    /// what lets the opener stand on the shared stack.
    pub(super) fn closing(&mut self, open_at: usize, open: char, close: char) -> Option<usize> {
        let text = self.text;
        debug_assert!(!self.escaped()[open_at], "an escaped opener at {open_at}");
        if !self.matches.contains_key(&open) {
            let escaped = self.escaped();
            let mut matches = vec![None; text.len()];
            let mut stack = Vec::new();
            for (i, c) in text.iter().enumerate() {
                if escaped[i] {
                    continue;
                }
                if *c == open {
                    stack.push(i);
                } else if *c == close
                    && let Some(opener) = stack.pop()
                {
                    matches[opener] = Some(i);
                }
            }
            self.matches.insert(open, matches);
        }
        self.matches[&open][open_at]
    }

    /// The closer `parseDelimited` finds for the `len` delimiter characters at
    /// `start`: the first run of them past the one right after the opener,
    /// not after a space or tab, and for a single character not part of a
    /// longer run.
    pub(super) fn delimiter(&mut self, start: usize, len: usize) -> Option<usize> {
        let text = self.text;
        let delimiter = text[start];
        let key = (delimiter, len);
        if !self.delimiters.contains_key(&key) {
            let escaped = self.escaped();
            let closes = |j: usize| {
                if j == 0 || escaped[j] || text.get(j..j + len).is_none() {
                    return false;
                }
                if text[j..j + len].iter().any(|c| *c != delimiter) {
                    return false;
                }
                let before = text[j - 1];
                let single_in_run = len == 1
                    && ((before == delimiter && !(j >= 2 && text[j - 2] == '\\'))
                        || text.get(j + len) == Some(&delimiter));
                !matches!(before, ' ' | '\t') && !single_in_run
            };
            let mut next = vec![text.len(); text.len() + 1];
            for j in (0..text.len()).rev() {
                next[j] = if closes(j) { j } else { next[j + 1] };
            }
            self.delimiters.insert(key, next);
        }
        let after_open = start + len;
        let found = self.delimiters[&key][after_open + 1];
        (found < text.len()).then_some(found)
    }

    /// `parseInlineCode` from the backtick at `start`: the span's opening
    /// run ends at `.0`, and the first run past it that is as long as the
    /// part of the run from `start` begins at `.1`.
    pub(super) fn code_span(&mut self, start: usize) -> Option<(usize, usize)> {
        let text = self.text;
        let ticks = self
            .ticks
            .get_or_insert_with(|| BacktickRuns::of_chars(text));
        let from = ticks.end_of(start);
        ticks.closing(from, from - start).map(|close| (from, close))
    }
}
