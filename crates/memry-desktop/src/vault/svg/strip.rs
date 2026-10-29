//! The passes of `sanitizeSvg` before the tag rewrite: comments, declarations, processing
//! instructions, CDATA, the forbidden elements and the unsafe `<style>` blocks. Each function
//! names the regex it replaces and gives the same result as `String.prototype.replace` with it.
//!
//! A pass that finds an opener with no end stops looking: every later opener would search a
//! shorter tail for the same end. That, and [`Finder`], keep each pass linear where the regex
//! iteration of the TypeScript is quadratic.

use super::attrs::is_safe_style;
use super::scan::{
    Finder, as_str, ci_at, exact_at, find_lit, prefixed_tag, spaces_then_gt, tick, word_ends,
};

/// Elements dropped together with everything inside them, in the TypeScript's order.
pub(super) const FORBIDDEN_ELEMENTS: [&str; 6] = [
    "script",
    "foreignObject",
    "iframe",
    "embed",
    "object",
    "handler",
];

/// Removes every match of `<open>[\s\S]*?<close>`, where `opens` recognizes the opener and
/// `open_len` is its length.
pub(super) fn strip_between(
    text: &[u8],
    opens: impl Fn(&[u8], usize) -> bool,
    open_len: usize,
    close: &str,
) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len());
    let (mut copied, mut at) = (0, 0);
    while at < text.len() {
        tick();
        if !opens(text, at) {
            at += 1;
            continue;
        }
        let Some(end) = find_lit(text, at + open_len, close) else {
            break;
        };
        out.extend_from_slice(&text[copied..at]);
        copied = end + close.len();
        at = copied;
    }
    out.extend_from_slice(&text[copied..]);
    out
}

/// `/<!--[\s\S]*?-->/g`
pub(super) fn strip_comments(text: &[u8]) -> Vec<u8> {
    strip_between(text, |t, at| exact_at(t, at, "<!--"), 4, "-->")
}

/// `/<!ENTITY[\s\S]*?>/gi`
pub(super) fn strip_entities(text: &[u8]) -> Vec<u8> {
    strip_between(text, |t, at| declaration_at(t, at, "ENTITY"), 8, ">")
}

/// `/<\?[\s\S]*?\?>/g`
pub(super) fn strip_processing_instructions(text: &[u8]) -> Vec<u8> {
    strip_between(text, |t, at| exact_at(t, at, "<?"), 2, "?>")
}

/// `/<!\[CDATA\[[\s\S]*?\]\]>/g`
pub(super) fn strip_cdata(text: &[u8]) -> Vec<u8> {
    strip_between(text, |t, at| exact_at(t, at, "<![CDATA["), 9, "]]>")
}

fn declaration_at(text: &[u8], at: usize, keyword: &str) -> bool {
    exact_at(text, at, "<!") && ci_at(text, at + 2, keyword)
}

/// `/<!DOCTYPE[^>[]*(?:\[[\s\S]*?\])?[^>]*>/gi`, the DOCTYPE with any internal subset.
///
/// After `[^>[]*` stops at `q`: a `>` there ends the match. A `[` there opens the subset,
/// which the lazy group closes at the first `]` that a later `>` follows; with none, the group
/// is skipped and `[^>]*>` ends at the first `>` after `q`.
pub(super) fn strip_doctypes(text: &[u8]) -> Vec<u8> {
    let mut gt = Finder::new(b'>', text);
    let mut close_bracket = Finder::new(b']', text);
    let mut out = Vec::with_capacity(text.len());
    let (mut copied, mut at) = (0, 0);
    while at < text.len() {
        tick();
        if !declaration_at(text, at, "DOCTYPE") {
            at += 1;
            continue;
        }
        let mut q = at + 9;
        while q < text.len() && text[q] != b'>' && text[q] != b'[' {
            tick();
            q += 1;
        }
        if q == text.len() {
            break;
        }
        let end = if text[q] == b'>' {
            q + 1
        } else {
            let Some(first_gt) = gt.next(text, q + 1) else {
                break;
            };
            match close_bracket.next(text, q + 1) {
                Some(bracket) if bracket > first_gt => {
                    gt.next(text, bracket + 1).unwrap_or(first_gt) + 1
                }
                _ => first_gt + 1,
            }
        };
        out.extend_from_slice(&text[copied..at]);
        copied = end;
        at = end;
    }
    out.extend_from_slice(&text[copied..]);
    out
}

/// `stripForbiddenElements`: per element, the self-closing form, the paired form (content goes
/// with it), an unclosed opener (it takes the rest of the document) and stray closers.
pub(super) fn strip_forbidden_elements(mut text: Vec<u8>) -> Vec<u8> {
    for tag in FORBIDDEN_ELEMENTS {
        text = strip_self_closing(&text, tag);
        text = strip_paired(&text, tag, false, |_| true);
        text = strip_unclosed(text, tag);
        text = strip_stray_closers(&text, tag);
    }
    text
}

/// `<${TAG_PREFIX}${tag}\b` at `at`: the end of the tag name.
fn opener(text: &[u8], at: usize, tag: &str) -> Option<usize> {
    if text[at] != b'<' {
        return None;
    }
    prefixed_tag(text, at + 1, tag, word_ends)
}

/// `<\/${TAG_PREFIX}${tag}\s*>` at `at`: the index after its `>`.
fn closer(text: &[u8], at: usize, tag: &str) -> Option<usize> {
    if text[at] != b'<' || text.get(at + 1) != Some(&b'/') {
        return None;
    }
    prefixed_tag(text, at + 2, tag, spaces_then_gt)
}

/// `<${TAG_PREFIX}${tag}\b[^>]*\/>`, globally.
fn strip_self_closing(text: &[u8], tag: &str) -> Vec<u8> {
    let mut gt = Finder::new(b'>', text);
    let mut out = Vec::with_capacity(text.len());
    let (mut copied, mut at) = (0, 0);
    while at < text.len() {
        tick();
        let Some(name_end) = opener(text, at, tag) else {
            at += 1;
            continue;
        };
        let Some(close) = gt.next(text, name_end) else {
            break;
        };
        if text[close - 1] != b'/' {
            at += 1;
            continue;
        }
        out.extend_from_slice(&text[copied..at]);
        copied = close + 1;
        at = copied;
    }
    out.extend_from_slice(&text[copied..]);
    out
}

/// `<${TAG_PREFIX}${tag}\b[\s\S]*?<\/${TAG_PREFIX}${tag}\s*>`, globally, or with
/// `head_to_gt` `<${TAG_PREFIX}${tag}\b[^>]*>([\s\S]*?)<\/${TAG_PREFIX}${tag}\s*>` (the
/// `<style>` pass). A match goes when `drop` of its inner text says so.
///
/// An opener with no closer after it ends the pass: a later opener searches a shorter tail.
fn strip_paired(text: &[u8], tag: &str, head_to_gt: bool, drop: impl Fn(&[u8]) -> bool) -> Vec<u8> {
    let mut gt = Finder::new(b'>', text);
    let mut out = Vec::with_capacity(text.len());
    let (mut copied, mut at) = (0, 0);
    while at < text.len() {
        tick();
        let Some(name_end) = opener(text, at, tag) else {
            at += 1;
            continue;
        };
        let inner_start = if head_to_gt {
            let Some(close) = gt.next(text, name_end) else {
                break;
            };
            close + 1
        } else {
            name_end
        };
        let Some((inner_end, end)) = (inner_start..text.len()).find_map(|t| {
            tick();
            closer(text, t, tag).map(|end| (t, end))
        }) else {
            break;
        };
        if drop(&text[inner_start..inner_end]) {
            out.extend_from_slice(&text[copied..at]);
            copied = end;
        }
        at = end;
    }
    out.extend_from_slice(&text[copied..]);
    out
}

/// `<${TAG_PREFIX}${tag}\b[\s\S]*$`, first match only: the rest of the document goes.
fn strip_unclosed(mut text: Vec<u8>, tag: &str) -> Vec<u8> {
    if let Some(at) = (0..text.len()).find(|&at| {
        tick();
        opener(&text, at, tag).is_some()
    }) {
        text.truncate(at);
    }
    text
}

/// `<\/${TAG_PREFIX}${tag}\b[^>]*>`, globally.
fn strip_stray_closers(text: &[u8], tag: &str) -> Vec<u8> {
    let mut gt = Finder::new(b'>', text);
    let mut out = Vec::with_capacity(text.len());
    let (mut copied, mut at) = (0, 0);
    while at < text.len() {
        tick();
        let name_end = (text[at] == b'<' && text.get(at + 1) == Some(&b'/'))
            .then(|| prefixed_tag(text, at + 2, tag, word_ends))
            .flatten();
        let Some(name_end) = name_end else {
            at += 1;
            continue;
        };
        let Some(close) = gt.next(text, name_end) else {
            break;
        };
        out.extend_from_slice(&text[copied..at]);
        copied = close + 1;
        at = copied;
    }
    out.extend_from_slice(&text[copied..]);
    out
}

/// `stripUnsafeStyleElements`: a `<style>` block whose CSS reaches outside the document
/// (`@import`, `url()` other than a fragment, `expression(`, `javascript:`) goes.
pub(super) fn strip_unsafe_styles(text: &[u8]) -> Vec<u8> {
    strip_paired(text, "style", true, |css| !is_safe_style(as_str(css)))
}
