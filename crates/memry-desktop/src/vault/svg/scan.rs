//! What the passes share: the JavaScript character classes of the TypeScript's regexes, the
//! namespace-prefix chain, and a single-byte search that never scans a stretch twice.
//!
//! The passes scan UTF-8 bytes. Every delimiter they look for is ASCII, and an ASCII byte is
//! never part of a longer character, so every cut lands on a character boundary. JavaScript's
//! `\s` also holds characters above U+007F; [`ws_len`] recognizes them by their lead byte.
//!
//! Every loop that walks the text calls [`tick`], so a test can bound the work by steps
//! ([`steps`]) instead of wall-clock time.

use std::cell::Cell;

thread_local! {
    static STEPS: Cell<usize> = const { Cell::new(0) };
}

/// Bytes the sanitizer has looked at on this thread.
#[doc(hidden)]
pub fn steps() -> usize {
    STEPS.with(Cell::get)
}

pub(super) fn tick() {
    STEPS.with(|s| s.set(s.get() + 1));
}

/// A cut of the input at ASCII bytes, as text. Every pass cuts only there, so it is valid UTF-8.
pub(super) fn as_str(bytes: &[u8]) -> &str {
    std::str::from_utf8(bytes).expect("the passes cut the text only at ASCII bytes")
}

/// The length of the regex `\s` character (no `u` flag: WhiteSpace plus LineTerminator) that
/// starts at `at`, or 0. U+0085 is not one; U+FEFF is.
pub(super) fn ws_len(text: &[u8], at: usize) -> usize {
    let next = |offset: usize| text.get(at + offset).copied();
    match (next(0), next(1), next(2)) {
        (Some(0x09..=0x0d | b' '), _, _) => 1,
        (Some(0xc2), Some(0xa0), _) => 2,
        (Some(0xe1), Some(0x9a), Some(0x80))
        | (Some(0xe2), Some(0x80), Some(0x80..=0x8a | 0xa8 | 0xa9 | 0xaf))
        | (Some(0xe2), Some(0x81), Some(0x9f))
        | (Some(0xe3), Some(0x80), Some(0x80))
        | (Some(0xef), Some(0xbb), Some(0xbf)) => 3,
        _ => 0,
    }
}

/// The index after the run of `\s` characters at `at`.
pub(super) fn skip_ws(text: &[u8], mut at: usize) -> usize {
    loop {
        tick();
        match ws_len(text, at) {
            0 => return at,
            len => at += len,
        }
    }
}

/// Regex `\w` and the word side of `\b` without the `u` flag: ASCII only.
pub(super) fn is_word(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

/// `lit` at `at`, letters compared ASCII case-insensitively, as a regex with the `i` flag and
/// without `u` compares them: `ſ` never matches `s`, nor the Kelvin sign `k`. `lit` is ASCII.
pub(super) fn ci_at(text: &[u8], at: usize, lit: &str) -> bool {
    text.get(at..at + lit.len()).is_some_and(|window| {
        tick();
        window.eq_ignore_ascii_case(lit.as_bytes())
    })
}

/// `lit` at `at`, exactly.
pub(super) fn exact_at(text: &[u8], at: usize, lit: &str) -> bool {
    text.get(at..at + lit.len()).is_some_and(|window| {
        tick();
        window == lit.as_bytes()
    })
}

/// First index `>= from` where `lit` starts exactly.
pub(super) fn find_lit(text: &[u8], from: usize, lit: &str) -> Option<usize> {
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
    want: u8,
    none_from: usize,
    last: Option<(usize, usize)>,
}

impl Finder {
    pub(super) fn new(want: u8, text: &[u8]) -> Self {
        Self {
            want,
            none_from: text.len(),
            last: None,
        }
    }

    pub(super) fn next(&mut self, text: &[u8], from: usize) -> Option<usize> {
        if from >= self.none_from {
            return None;
        }
        if let Some((asked, hit)) = self.last
            && asked <= from
            && from <= hit
        {
            return Some(hit);
        }
        let want = self.want;
        let hit = text[from..self.none_from].iter().position(|byte| {
            tick();
            *byte == want
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
    text: &[u8],
    from: usize,
    tag: &str,
    follows: impl Fn(&[u8], usize) -> Option<usize>,
) -> Option<usize> {
    let mut starts = vec![from];
    let mut at = from;
    while text
        .get(at)
        .is_some_and(|b| b.is_ascii_alphabetic() || *b == b'_')
    {
        let mut end = at + 1;
        while text
            .get(end)
            .is_some_and(|b| is_word(*b) || *b == b'.' || *b == b'-')
        {
            tick();
            end += 1;
        }
        if text.get(end) != Some(&b':') {
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
pub(super) fn word_ends(text: &[u8], at: usize) -> Option<usize> {
    (!text.get(at).copied().is_some_and(is_word)).then_some(at)
}

/// `\s*>` at `at`: the index after the `>`.
pub(super) fn spaces_then_gt(text: &[u8], at: usize) -> Option<usize> {
    let at = skip_ws(text, at);
    (text.get(at) == Some(&b'>')).then_some(at + 1)
}

/// `squash`: drops every character at or below U+0020, the classic scheme-smuggling trick
/// (`java\tscript:`). Those are all single bytes.
pub(super) fn squash(value: &str) -> String {
    value
        .chars()
        .filter(|c| {
            tick();
            u32::from(*c) > 0x20
        })
        .collect()
}
