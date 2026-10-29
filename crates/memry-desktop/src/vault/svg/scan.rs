//! What the sanitizer's passes share: the JavaScript character classes its regexes use, the
//! namespace-prefix chain, and a single-character search that never scans a stretch twice.
//!
//! Every loop that walks the text calls [`tick`], so a test can bound the work by steps
//! (`steps`) instead of wall-clock time.

use std::cell::Cell;

use crate::web::extract::utils::js::is_js_whitespace;

thread_local! {
    static STEPS: Cell<usize> = const { Cell::new(0) };
}

/// Characters the sanitizer has looked at on this thread.
#[doc(hidden)]
pub fn steps() -> usize {
    STEPS.with(Cell::get)
}

pub(super) fn tick() {
    STEPS.with(|s| s.set(s.get() + 1));
}

/// Regex `\s` without the `u` flag: JavaScript's WhiteSpace plus LineTerminator.
pub(super) fn is_ws(c: char) -> bool {
    is_js_whitespace(c)
}

/// Regex `\w` and the word side of `\b` without the `u` flag: ASCII only.
pub(super) fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// `lit` at `at`, letters compared ASCII case-insensitively, as a regex with the `i` flag and
/// without `u` compares them: `ſ` never matches `s`, nor the Kelvin sign `k`. `lit` is ASCII.
pub(super) fn ci_at(text: &[char], at: usize, lit: &str) -> bool {
    let Some(window) = text.get(at..at + lit.len()) else {
        return false;
    };
    window.iter().zip(lit.chars()).all(|(c, l)| {
        tick();
        c.eq_ignore_ascii_case(&l)
    })
}

/// `lit` at `at`, exactly.
pub(super) fn exact_at(text: &[char], at: usize, lit: &str) -> bool {
    let Some(window) = text.get(at..at + lit.len()) else {
        return false;
    };
    window.iter().zip(lit.chars()).all(|(c, l)| {
        tick();
        *c == l
    })
}

/// First index `>= from` where `lit` starts exactly.
pub(super) fn find_lit(text: &[char], from: usize, lit: &str) -> Option<usize> {
    (from..text.len()).find(|&at| {
        tick();
        exact_at(text, at, lit)
    })
}

/// First index `>= from` holding `want`. Answers are remembered both ways, so the passes'
/// repeated questions cost one scan of each stretch: `none_from` is the lowest index known to
/// have no `want` at or after it, and `last` the most recent hit with the index it was asked
/// from (no `want` lies between the two).
pub(super) struct Finder {
    want: char,
    none_from: usize,
    last: Option<(usize, usize)>,
}

impl Finder {
    pub(super) fn new(want: char, text: &[char]) -> Self {
        Self {
            want,
            none_from: text.len(),
            last: None,
        }
    }

    pub(super) fn next(&mut self, text: &[char], from: usize) -> Option<usize> {
        if from >= self.none_from {
            return None;
        }
        if let Some((asked, hit)) = self.last
            && asked <= from
            && from <= hit
        {
            return Some(hit);
        }
        let hit = text[from..self.none_from].iter().position(|c| {
            tick();
            *c == self.want
        });
        match hit {
            Some(offset) => {
                self.last = Some((from, from + offset));
                Some(from + offset)
            }
            None => {
                self.none_from = from;
                None
            }
        }
    }
}

/// `(?:[A-Za-z_][\w.-]*:)*` then `tag`, at `from`, then what `follows` matches from the end of
/// `tag`: the end of the whole match, for the first place the chain lets `tag` start, most
/// prefix segments first as the greedy regex tries them. `<svg:script` and `<a:b:script` name
/// `script`, so a prefix is never a way past a rule.
pub(super) fn prefixed_tag(
    text: &[char],
    from: usize,
    tag: &str,
    follows: impl Fn(&[char], usize) -> Option<usize>,
) -> Option<usize> {
    let mut starts = vec![from];
    let mut at = from;
    while text
        .get(at)
        .is_some_and(|c| c.is_ascii_alphabetic() || *c == '_')
    {
        let mut end = at + 1;
        while text
            .get(end)
            .is_some_and(|c| is_word(*c) || *c == '.' || *c == '-')
        {
            tick();
            end += 1;
        }
        if text.get(end) != Some(&':') {
            break;
        }
        at = end + 1;
        starts.push(at);
    }
    starts
        .into_iter()
        .rev()
        .find_map(|start| ci_at(text, start, tag).then(|| follows(text, start + tag.len()))?)
}

/// Regex `\b` right after a word character: what follows is no word character.
pub(super) fn word_ends(text: &[char], at: usize) -> Option<usize> {
    (!text.get(at).copied().is_some_and(is_word)).then_some(at)
}

/// `\s*>` at `at`: the index after the `>`.
pub(super) fn spaces_then_gt(text: &[char], at: usize) -> Option<usize> {
    let mut at = at;
    while text.get(at).copied().is_some_and(is_ws) {
        tick();
        at += 1;
    }
    (text.get(at) == Some(&'>')).then_some(at + 1)
}
