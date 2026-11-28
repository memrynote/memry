//! Raw HTML the editor does not handle, kept as the text the author wrote:
//! `packages/editor-schema/src/inline/raw-html.ts` (`maskRawHtml`), which says
//! why (chapter 12 §12.1.0 states the rule).
//!
//! Every `<` that opens a construct the editor has no node for is hidden from
//! the parse and put back as text. A tag, declaration, CDATA section or
//! processing instruction that closes on its own line within [`BOUND`] UTF-16
//! units is one token holding all of it; any other candidate (a tag that closes
//! on a later line, `<div` with no `>`, one past the bound, one with a `|` in
//! it) hides only its `<`. The tags the editor does handle are left alone, and
//! so is a `<` inside code or opening a link's address. The token is
//! `;MEMRYRAW<word><n>;`, bounded by characters that are no markup, so
//! emphasis next to a tag reads as it did with the angle brackets there.
//!
//! A backslash before the `<` of a tag the editor handles
//! ([`super::handled::reads_as_markup`]) escapes it: the tag is text, the
//! backslash is no part of it, and it counts for nothing against the nesting
//! cap. The writer spells text that holds such a tag that way
//! ([`super::escapes`]). A backslash before any other tag is text, as ever.
//!
//! A tag that holds a `<!--` comment is left alone too: desktop reads the comment
//! as one token inside the tag (and keeps a comment on one line as the tag's own
//! characters), which this port cannot size, so its block goes to the fallback.
//!
//! A tag left alone still sends its block to the fallback
//! ([`fallback`]): this port builds no mark for it.

use std::borrow::Cow;
use std::sync::LazyLock;

use super::SeedBlock;
use super::handled::{Scan, is_handled, names_handled_tag, opens_within_cap, reads_as_markup};
use super::html_tag::{Closers, Line, is_blank, opens_construct, read_construct};
use super::markers::FenceTracker;
use super::mask_word::mask_word;
use super::mentions;

/// The characters `tryBackslashEscape` takes after a backslash.
const ESCAPABLE: &str = "\\`*_{}[]()#+-.!~|>";

/// `;MEMRYRAW` and the process's mask word: no source text spells a token.
fn token_prefix() -> &'static str {
    static PREFIX: LazyLock<String> = LazyLock::new(|| format!(";MEMRYRAW{}", mask_word()));
    &PREFIX
}

/// `[start, end)` of a hidden range, in characters of the scanned text: one
/// character for a lone `<`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Span {
    pub(super) start: usize,
    pub(super) end: usize,
    /// A tag the editor handles that the text spells literally: its `<` is
    /// escaped. In a note a backslash stands at `start - 1` and is no part of
    /// the text; in the text of a run, the writer puts one there.
    pub(super) escaped: bool,
}

impl Span {
    fn hidden(start: usize, end: usize) -> Self {
        Self {
            start,
            end,
            escaped: false,
        }
    }

    fn escaped(start: usize, end: usize) -> Self {
        Self {
            start,
            end,
            escaped: true,
        }
    }
}

/// Where the first non-blank character after a link's `](` is.
fn address_start(line: &Line, close: usize) -> Option<usize> {
    if line.get(close + 1) != Some('(') {
        return None;
    }
    let mut at = close + 2;
    while is_blank(line.get(at)) {
        at += 1;
    }
    Some(at)
}

/// Where to read on after the backtick run at `at`: past the span it opens when
/// a run of the same length closes it on this line, else past the run.
fn code_span_end(chars: &[char], at: usize) -> usize {
    let mut run = at;
    while chars.get(run) == Some(&'`') {
        run += 1;
    }
    let length = run - at;
    let mut from = run;
    while let Some(tick) = chars[from.min(chars.len())..]
        .iter()
        .position(|&c| c == '`')
    {
        let tick = from + tick;
        let mut end = tick;
        while chars.get(end) == Some(&'`') {
            end += 1;
        }
        if end - tick == length {
            return end;
        }
        from = end;
    }
    run
}

fn scan_line(chars: &[char], base: usize, markdown: bool, scan: &mut Scan, spans: &mut Vec<Span>) {
    let line = Line::new(chars);
    let n = chars.len();
    // The `[` this line has left open, and where the address of the last link
    // starts: `[a](<x y>)` is a destination the link mask reads.
    let mut depth = 0usize;
    let mut address: Option<usize> = None;
    let mut closers = Closers::new();
    let mut at = 0;
    while at < n {
        let ch = chars[at];
        if ch == '<' {
            if opens_construct(&line, at) && address != Some(at) {
                match read_construct(&line, at, &mut closers) {
                    None => {
                        let within = names_handled_tag(&line, at)
                            .is_some_and(|(name, closing)| opens_within_cap(&name, closing, scan));
                        if !within {
                            spans.push(Span::hidden(base + at, base + at + 1));
                        }
                    }
                    Some(found) => {
                        if let Some(tag) = &found.tag
                            && is_handled(tag, scan)
                        {
                            if !markdown && reads_as_markup(tag) {
                                // The writer escapes it. A row splits at a
                                // pipe before it reads a tag.
                                if chars[at..found.end].contains(&'|') {
                                    spans.push(Span::escaped(base + at, base + at + 1));
                                    at += 1;
                                } else {
                                    spans.push(Span::escaped(base + at, base + found.end));
                                    at = found.end;
                                }
                                continue;
                            }
                            at = found.end;
                            continue;
                        }
                        // Desktop reads the comment inside it as one token, so
                        // where the tag ends depends on a length and on quotes
                        // this port does not see: the line falls back.
                        if markdown
                            && chars[at..found.end]
                                .windows(4)
                                .any(|w| w == ['<', '!', '-', '-'])
                        {
                            at = found.end;
                            continue;
                        }
                        // A row splits at a pipe before it reads a tag.
                        if chars[at..found.end].contains(&'|') {
                            spans.push(Span::hidden(base + at, base + at + 1));
                        } else {
                            spans.push(Span::hidden(base + at, base + found.end));
                            at = found.end;
                            continue;
                        }
                    }
                }
            }
        } else if markdown {
            match ch {
                '\\' if chars.get(at + 1) == Some(&'<') => {
                    let found = (address != Some(at + 1) && opens_construct(&line, at + 1))
                        .then(|| read_construct(&line, at + 1, &mut closers))
                        .flatten();
                    if let Some(found) = found
                        && let Some(tag) = &found.tag
                        && reads_as_markup(tag)
                    {
                        if chars[at + 1..found.end].contains(&'|') {
                            spans.push(Span::escaped(base + at + 1, base + at + 2));
                            at += 2;
                        } else {
                            spans.push(Span::escaped(base + at + 1, base + found.end));
                            at = found.end;
                        }
                        continue;
                    }
                }
                '\\' => {
                    if at + 1 < n && ESCAPABLE.contains(chars[at + 1]) {
                        at += 1;
                    }
                }
                '`' => {
                    at = code_span_end(chars, at);
                    continue;
                }
                '[' => depth += 1,
                ']' if depth > 0 => {
                    depth -= 1;
                    address = address_start(&line, at);
                }
                _ => {}
            }
        }
        at += 1;
    }
}

/// The hidden ranges of `text`, in order. In `markdown` mode `text` is a note
/// and its fences, code spans, backslash escapes and link addresses are read;
/// in text mode it is the characters of a text run, which the writer spells.
pub(super) fn scan(text: &str, markdown: bool) -> Vec<Span> {
    let mut spans = Vec::new();
    if !text.contains('<') {
        return spans;
    }
    let mut scan = Scan::new(markdown);
    let mut fence = FenceTracker::default();
    let mut base = 0;
    for line in text.split('\n') {
        let chars: Vec<char> = line.chars().collect();
        let in_fence = markdown && fence.consume(line);
        if !in_fence {
            scan.line(line);
        }
        if !in_fence && line.contains('<') {
            scan_line(&chars, base, markdown, &mut scan, &mut spans);
        }
        base += chars.len() + 1;
    }
    spans
}

/// Why a line holding raw HTML sends its block to the fallback, or `None`: a
/// `<` outside code, followed by a letter, `/`, `!` or `?`. Read on the line
/// with the raw HTML the editor does not handle hidden, so what is left is a
/// tag it handles, which this seed builds no mark for.
pub(super) fn fallback(line: &str) -> Option<&'static str> {
    let chars: Vec<char> = line.chars().collect();
    let mut at = 0;
    while at < chars.len() {
        match chars[at] {
            '\\' if at + 1 < chars.len() && ESCAPABLE.contains(chars[at + 1]) => at += 1,
            '`' => {
                at = code_span_end(&chars, at);
                continue;
            }
            '<' if chars
                .get(at + 1)
                .is_some_and(|c| c.is_ascii_alphabetic() || matches!(c, '/' | '!' | '?')) =>
            {
                return Some("HTML");
            }
            _ => {}
        }
        at += 1;
    }
    None
}

/// The tags `text` spells whole, which the writer must leave as they are, and
/// the `<` of each one the editor handles, which it escapes.
pub(super) fn spelled_tags(text: &str) -> Vec<Span> {
    scan(text, false)
        .into_iter()
        .filter(|span| span.end - span.start > 1 || span.escaped)
        .collect()
}

/// `maskRawHtml`: `markdown` with every `<` that opens raw HTML the editor
/// does not handle hidden, and what each token replaced.
pub(super) fn mask(markdown: &str) -> (String, Vec<String>) {
    let spans = scan(markdown, true);
    if spans.is_empty() {
        return (markdown.to_owned(), Vec::new());
    }
    let chars: Vec<char> = markdown.chars().collect();
    let mut sources = Vec::with_capacity(spans.len());
    let mut out = String::with_capacity(markdown.len());
    let mut last = 0;
    for Span {
        start,
        end,
        escaped,
    } in spans
    {
        // An escaped tag's backslash goes with it: the text is the tag.
        out.extend(&chars[last..if escaped { start - 1 } else { start }]);
        out.push_str(&format!("{}{};", token_prefix(), sources.len()));
        sources.push(chars[start..end].iter().collect());
        last = end;
    }
    out.extend(&chars[last..]);
    (out, sources)
}

/// `restoreRawHtml`: `text` with the tokens [`mask`] made turned back into
/// their characters. A token no source matches is left as it is.
fn restore<'a>(text: &'a str, sources: &[String]) -> Cow<'a, str> {
    let prefix = token_prefix();
    if sources.is_empty() || !text.contains(prefix) {
        return Cow::Borrowed(text);
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find(prefix) {
        out.push_str(&rest[..at]);
        let after = &rest[at + prefix.len()..];
        let digits = after.bytes().take_while(u8::is_ascii_digit).count();
        let source = after[digits..]
            .starts_with(';')
            .then(|| after[..digits].parse::<usize>().ok())
            .flatten()
            .and_then(|index| sources.get(index));
        match source {
            Some(source) => {
                out.push_str(source);
                rest = &after[digits + 1..];
            }
            None => {
                out.push_str(&rest[at..at + prefix.len()]);
                rest = after;
            }
        }
    }
    out.push_str(rest);
    Cow::Owned(out)
}

/// Whether a token was put back in `text`.
fn restore_in(text: &mut String, sources: &[String]) -> bool {
    match restore(text, sources) {
        Cow::Owned(restored) => {
            *text = restored;
            true
        }
        Cow::Borrowed(_) => false,
    }
}

/// [`restore`] over every string a parsed block holds ([`super::props`]).
pub(super) fn restore_blocks(blocks: &mut [SeedBlock], sources: &[String]) {
    if sources.is_empty() {
        return;
    }
    super::props::each_string(blocks, true, &mut |value| {
        // A hidden tag holds the placeholders of the `((…))` tokens it held,
        // which a string puts back after it, as desktop's `repairRuns` does.
        if restore_in(value, sources) {
            *value = mentions::restore(value);
        }
    });
}

#[cfg(test)]
#[path = "raw_html_tests.rs"]
mod tests;
