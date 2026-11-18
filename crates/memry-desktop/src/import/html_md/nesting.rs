//! The nesting check that runs before html5ever parses an imported page. The tree builder scans
//! its stack of open elements for most tags, so its time grows with the square of the nesting:
//! a page of 100,000 nested `<div>` takes many minutes to parse. This scan passes over the bytes
//! once and fails the page when its open tags nest past [`MAX_PARSE_DEPTH`].
//!
//! The scan counts what the parser would keep open: a start tag opens an element and its own
//! end tag closes one of that name. Void elements, tags whose start closes an open one of the
//! same kind (`p`, `li`, `td`, `a`) and raw-text elements never nest by themselves, so they are
//! not counted, and a page that leaves its paragraphs unclosed still passes. The count is an
//! upper bound of the depth for well-formed nesting; the converter's [`MAX_DEPTH`] still
//! decides on the tree the parser builds.

use std::cell::Cell;
use std::collections::HashMap;

use super::{HtmlMdError, MAX_DEPTH};

/// Open tags the scan allows. Above [`MAX_DEPTH`], so the converter, which sees the real tree,
/// decides every page the parser can build quickly.
pub const MAX_PARSE_DEPTH: usize = 4 * MAX_DEPTH;

const VOID: [&str; 18] = [
    "area", "base", "basefont", "bgsound", "br", "col", "embed", "frame", "hr", "image", "img",
    "input", "keygen", "link", "meta", "param", "source", "track",
];
/// A start tag of one closes the open one, or the parser ignores it, so they do not nest
/// without a counted element between them.
const NO_SELF_NESTING: [&str; 26] = [
    "a", "body", "button", "caption", "colgroup", "dd", "dt", "form", "head", "html", "li", "nobr",
    "option", "optgroup", "p", "rb", "rp", "rt", "rtc", "select", "tbody", "td", "tfoot", "th",
    "thead", "tr",
];
/// Elements whose content is text up to their end tag.
const RAW_TEXT: [&str; 8] = [
    "iframe", "noembed", "noframes", "script", "style", "textarea", "title", "xmp",
];

thread_local! {
    static STEPS: Cell<usize> = const { Cell::new(0) };
}

/// Bytes this thread's nesting scans have examined.
#[doc(hidden)]
pub fn nesting_scan_steps() -> usize {
    STEPS.with(Cell::get)
}

/// The bytes from `from` up to the first one `stop` accepts (or the end), charged as examined.
fn find(bytes: &[u8], from: usize, stop: impl Fn(&[u8], usize) -> bool) -> usize {
    let mut at = from;
    while at < bytes.len() && !stop(bytes, at) {
        at += 1;
    }
    STEPS.with(|steps| steps.set(steps.get() + at.saturating_sub(from)));
    at
}

fn starts_with_ci(bytes: &[u8], at: usize, prefix: &[u8]) -> bool {
    bytes
        .get(at..at + prefix.len())
        .is_some_and(|head| head.eq_ignore_ascii_case(prefix))
}

/// Fails with [`HtmlMdError::TooDeep`] when the open tags of `html` nest past
/// [`MAX_PARSE_DEPTH`]. Examines each byte at most once: the ranges `find` passes over are
/// disjoint.
pub fn check_nesting(html: &str) -> Result<(), HtmlMdError> {
    let bytes = html.as_bytes();
    let mut open: HashMap<String, usize> = HashMap::new();
    let mut depth = 0;
    let mut at = 0;
    while at < bytes.len() {
        let lt = find(bytes, at, |b, i| b[i] == b'<');
        if lt == bytes.len() {
            break;
        }
        if starts_with_ci(bytes, lt + 1, b"!--") {
            at = find(bytes, lt + 4, |b, i| starts_with_ci(b, i, b"-->")) + 3;
            continue;
        }
        let end_tag = bytes.get(lt + 1) == Some(&b'/');
        let name_start = lt + 1 + usize::from(end_tag);
        if !bytes.get(name_start).is_some_and(u8::is_ascii_alphabetic) {
            // `<!doctype>`, `<?pi>` and a bare `<` open nothing.
            at = lt + 1;
            continue;
        }
        let name_end = find(bytes, name_start, |b, i| {
            b[i].is_ascii_whitespace() || b[i] == b'/' || b[i] == b'>'
        });
        let name = html[name_start..name_end].to_ascii_lowercase();
        at = find(bytes, name_end, |b, i| b[i] == b'>') + 1;
        if end_tag {
            if let Some(count) = open.get_mut(&name).filter(|count| **count > 0) {
                *count -= 1;
                depth -= 1;
            }
            continue;
        }
        if name == "plaintext" {
            // Everything after it is text.
            break;
        }
        if RAW_TEXT.contains(&name.as_str()) {
            let close = format!("</{name}");
            at = find(bytes, at, |b, i| starts_with_ci(b, i, close.as_bytes()));
            continue;
        }
        if VOID.contains(&name.as_str()) || NO_SELF_NESTING.contains(&name.as_str()) {
            continue;
        }
        *open.entry(name).or_default() += 1;
        depth += 1;
        if depth > MAX_PARSE_DEPTH {
            return Err(HtmlMdError::TooDeep);
        }
    }
    Ok(())
}
