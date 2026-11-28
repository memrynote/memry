//! Which tags the editor handles, and how deep a scan lets them nest.
//!
//! `packages/editor-schema/src/inline/raw-html.ts` (`HANDLED_TAGS`,
//! `Nesting`) is the reference, and [`super::raw_html`] says why a tag the
//! editor does not handle is hidden. A handled tag is left to the HTML parse,
//! which recurses once per open one: 4000 unclosed `<b>` took 5 s there and
//! 8000 overflowed the stack. A handled tag opened while [`MAX_NESTING`]
//! handled tags are open is text too, and so is its closing tag.

use std::collections::HashMap;

use super::html_tag::{Line, Tag, is_blank, is_name_char};
use super::nesting::MAX_NESTING;

/// The tags the editor turns into a mark, a node or a line break, by name
/// (`HANDLED_TAGS` of `raw-html.ts`).
const HANDLED: [&str; 39] = [
    "b",
    "strong",
    "i",
    "em",
    "u",
    "s",
    "del",
    "strike",
    "code",
    "a",
    "img",
    "br",
    "figure",
    "figcaption",
    "video",
    "audio",
    "source",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "blockquote",
    "pre",
    "ul",
    "ol",
    "li",
    "table",
    "thead",
    "tbody",
    "tfoot",
    "tr",
    "td",
    "th",
    "caption",
    "colgroup",
    "col",
];

/// The handled tags that hold nothing, so they never nest.
const VOID: [&str; 6] = ["br", "img", "hr", "source", "col", "input"];

/// The handled tags a scan has left open.
#[derive(Default)]
pub(super) struct Nesting {
    /// For each `<span>` still open, whether it has a `style`.
    spans: Vec<bool>,
    /// For each handled tag still open, by name, whether the cap made it text.
    open: HashMap<String, Vec<bool>>,
    /// The open handled tags the cap did not make text.
    depth: usize,
}

impl Nesting {
    /// Counts a handled tag toward the nesting and says whether it is still
    /// within the cap. A closing tag belongs to the innermost open tag of its
    /// name, and is text when that tag is; one that closes nothing is read as
    /// it was.
    pub(super) fn within(&mut self, name: &str, closing: bool) -> bool {
        if VOID.contains(&name) {
            return true;
        }
        let stack = self.open.entry(name.to_owned()).or_default();
        if closing {
            let capped = stack.pop();
            if capped == Some(false) {
                self.depth -= 1;
            }
            return capped != Some(true);
        }
        let capped = self.depth >= MAX_NESTING;
        stack.push(capped);
        if !capped {
            self.depth += 1;
        }
        !capped
    }
}

/// A handled tag's name with a blank, `/` or `>` (or the line's end) after it,
/// and whether it closes: it may close on a later line, and the editor reads it
/// then as it does now.
pub(super) fn names_handled_tag(line: &Line, at: usize) -> Option<(String, bool)> {
    let mut p = at + 1;
    let closing = line.get(p) == Some('/');
    if closing {
        p += 1;
    }
    let start = p;
    while is_name_char(line.get(p)) {
        p += 1;
    }
    let name = line.c[start..p]
        .iter()
        .collect::<String>()
        .to_ascii_lowercase();
    (HANDLED.contains(&name.as_str())
        && (line.get(p).is_none()
            || is_blank(line.get(p))
            || matches!(line.get(p), Some('/' | '>'))))
    .then_some((name, closing))
}

/// Whether the editor handles `tag`, within the nesting cap. `nesting.spans`
/// holds, for each `<span>` still open, whether it has a `style`: a `</span>`
/// belongs to the innermost one, and one closing a plain span, or nothing, is
/// text.
pub(super) fn is_handled(tag: &Tag, nesting: &mut Nesting) -> bool {
    reads_as_handled(tag, &mut nesting.spans) && nesting.within(&tag.name, tag.closing)
}

fn reads_as_handled(tag: &Tag, open: &mut Vec<bool>) -> bool {
    let has = |name: &str| tag.attrs.iter().any(|(attr, _)| attr == name);
    match tag.name.as_str() {
        "span" => {
            if tag.closing {
                return open.pop() == Some(true);
            }
            let styled = has("style");
            if !tag.self_closing {
                open.push(styled);
            }
            styled
        }
        "details" => !tag.closing && has("data-memry-toggle"),
        "input" => {
            !tag.closing
                && tag
                    .attrs
                    .iter()
                    .any(|(attr, value)| attr == "type" && value.eq_ignore_ascii_case("checkbox"))
        }
        name => HANDLED.contains(&name),
    }
}
