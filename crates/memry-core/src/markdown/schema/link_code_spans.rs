//! Port of `packages/editor-schema/src/inline/link-code-spans.ts`: a code span
//! inside link text, kept as the link's own text (BBF-105).

use std::sync::LazyLock;

use regex::{Captures, Regex};

static LINK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)(<a(?-u:\b)[^>]*>)(.*?)(</a>)").expect("static pattern"));
static CODE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)<code>([^<]*)</code>").expect("static pattern"));

/// True when `value` holds a backtick run exactly `length` long.
fn has_backtick_run(value: &str, length: usize) -> bool {
    value.split(|c| c != '`').any(|run| run.len() == length)
}

/// CommonMark code span for `value`: a fence no backtick run in it matches,
/// padded when needed.
fn code_span(value: &str) -> String {
    let mut fence = 1;
    while has_backtick_run(value, fence) {
        fence += 1;
    }
    let fence = "`".repeat(fence);
    let pad = value.contains(|c| c != ' ')
        && ((value.starts_with(' ') && value.ends_with(' '))
            || value.starts_with('`')
            || value.ends_with('`'));
    if pad {
        format!("{fence} {value} {fence}")
    } else {
        format!("{fence}{value}{fence}")
    }
}

/// `html` with each code span inside a link written as backtick text.
pub fn link_code_as_text(html: &str) -> String {
    LINK.replace_all(html, |caps: &Captures| {
        let inner = CODE.replace_all(&caps[2], |code: &Captures| code_span(&code[1]));
        format!("{}{inner}{}", &caps[1], &caps[3])
    })
    .into_owned()
}

/// Each code-span-shaped run of `text`, as `(offset, length)` in UTF-16 code
/// units, the unit JavaScript string indices count in.
pub fn code_span_ranges(text: &str) -> Vec<(usize, usize)> {
    let bytes = text.as_bytes();
    let mut ranges = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] != b'`' {
            at += 1;
            continue;
        }
        let run_end = at + bytes[at..].iter().take_while(|b| **b == b'`').count();
        // An opener may start anywhere in the run and take what is left of it.
        let found = (at..run_end).find_map(|start| {
            let fence = run_end - start;
            closing_run(bytes, run_end, fence).map(|close| (start, close + fence))
        });
        match found {
            Some((start, end)) => {
                let before: usize = text[..start].encode_utf16().count();
                let length = text[start..end].encode_utf16().count();
                ranges.push((before, length));
                at = end;
            }
            None => at = run_end,
        }
    }
    ranges
}

/// Start of the first maximal backtick run exactly `fence` long after `from`.
fn closing_run(bytes: &[u8], from: usize, fence: usize) -> Option<usize> {
    // The content needs a character before the closer, and `from` is the first
    // non-backtick of the text.
    if from >= bytes.len() {
        return None;
    }
    let mut at = from + 1;
    while at < bytes.len() {
        if bytes[at] != b'`' {
            at += 1;
            continue;
        }
        let run = bytes[at..].iter().take_while(|b| **b == b'`').count();
        if run == fence {
            return Some(at);
        }
        at += run;
    }
    None
}
