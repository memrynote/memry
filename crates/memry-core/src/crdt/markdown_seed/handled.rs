//! Which tags the editor handles, and how deep a scan lets them nest.
//!
//! `packages/editor-schema/src/inline/raw-html.ts` (`HANDLED_TAGS`) is the
//! reference, and [`super::raw_html`] says why a tag the editor does not handle
//! is hidden. A handled tag is left to the HTML parse, which recurses once per
//! open one, so [`HtmlNesting`] counts the ones it holds open and a handled tag
//! opened past [`MAX_NESTING`] of them is text too, and so is its closing tag.

use super::html_nesting::{Close, HtmlNesting};
use super::html_tag::{Line, Tag, is_blank, is_name_char};
use crate::domain::journal_rules::is_js_whitespace;
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

/// The handled tags `isHtmlBlockStart` (`markdownToHtml.ts`) takes a line for
/// an HTML block of: the ones in its block-tag list.
const HTML_BLOCK_TAGS: [&str; 26] = [
    "audio",
    "blockquote",
    "caption",
    "col",
    "colgroup",
    "details",
    "figcaption",
    "figure",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "li",
    "ol",
    "source",
    "table",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "tr",
    "ul",
];

/// What a scan has met so far.
pub(super) struct Scan {
    /// The tags a note holds open. `None` in text mode, which counts none.
    pub(super) model: Option<HtmlNesting>,
    /// In text mode, for each `<span>` still open, whether it has a `style`.
    spans: Vec<bool>,
}

impl Scan {
    pub(super) fn new(markdown: bool) -> Self {
        Self {
            model: markdown.then(HtmlNesting::default),
            spans: Vec::new(),
        }
    }

    /// A blank line, or a line that starts an HTML block, as the model reads them.
    pub(super) fn line(&mut self, line: &str) {
        let Some(model) = self.model.as_mut() else {
            return;
        };
        if crate::domain::journal_rules::js_trim(line).is_empty() {
            model.blank_line();
        } else if starts_html_block(line) {
            model.html_block_line();
        }
    }
}

/// `isHtmlBlockStart`: a line of up to three spaces, then a tag of the
/// block-tag list. A tag the editor does not handle is hidden by now, so it
/// starts nothing.
fn starts_html_block(line: &str) -> bool {
    let bytes = line.as_bytes();
    let mut at = 0;
    while at < 3 && bytes.get(at) == Some(&b' ') {
        at += 1;
    }
    if bytes.get(at) != Some(&b'<') {
        return false;
    }
    at += 1;
    if bytes.get(at) == Some(&b'/') {
        at += 1;
    }
    let start = at;
    while bytes
        .get(at)
        .is_some_and(|b| b.is_ascii_alphanumeric() || *b == b'-')
    {
        at += 1;
    }
    let ends = match bytes.get(at) {
        None | Some(b'>') => true,
        Some(b'/') => bytes.get(at + 1) == Some(&b'>'),
        Some(_) => line[at..].chars().next().is_some_and(is_js_whitespace),
    };
    ends && bytes.get(start).is_some_and(u8::is_ascii_alphabetic)
        && HTML_BLOCK_TAGS.contains(&line[start..at].to_ascii_lowercase().as_str())
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

/// `readsAsMarkup`: whether the text `\<tag>` is a literal tag the editor would
/// otherwise read: a tag of [`HANDLED`], a checkbox. A `<span>` is left to its
/// own rules, and so is a toggle's `<details>`, which pairs with its
/// `</details>` across lines, so that an unterminated one stays the text it is.
pub(super) fn reads_as_markup(tag: &Tag) -> bool {
    match tag.name.as_str() {
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

/// Whether a handled tag that closes on a later line is within the cap.
pub(super) fn opens_within_cap(name: &str, closing: bool, scan: &mut Scan) -> bool {
    let Some(model) = scan.model.as_mut() else {
        return true;
    };
    if closing {
        return model.close(name) != Close::Literal;
    }
    VOID.contains(&name) || model.open(name, None)
}

/// The attributes of `tag`, spelled as one string to compare: the parse's list
/// of active formatting elements keeps three of any identical ones.
fn attributes_of(tag: &Tag) -> String {
    let mut attrs: Vec<String> = tag
        .attrs
        .iter()
        .map(|(name, value)| format!("{name}={value}"))
        .collect();
    attrs.sort();
    format!("{}\0{}", tag.name, attrs.join("\0"))
}

/// Whether the editor handles `tag`, within the nesting cap. A `</span>` belongs
/// to the innermost `<span>` that is open, and one closing a plain span, or
/// nothing, is text.
pub(super) fn is_handled(tag: &Tag, scan: &mut Scan) -> bool {
    let has = |name: &str| tag.attrs.iter().any(|(attr, _)| attr == name);
    match tag.name.as_str() {
        "span" => handles_span(tag, scan, has("style")),
        "details" => {
            if tag.closing
                && let Some(model) = scan.model.as_mut()
            {
                model.close("details");
            }
            !tag.closing
                && has("data-memry-toggle")
                && scan
                    .model
                    .as_mut()
                    .is_none_or(|model| model.open("details", None))
        }
        "input" => {
            !tag.closing
                && tag
                    .attrs
                    .iter()
                    .any(|(attr, value)| attr == "type" && value.eq_ignore_ascii_case("checkbox"))
        }
        name if !HANDLED.contains(&name) => false,
        name if VOID.contains(&name) => {
            if let Some(model) = scan.model.as_mut() {
                model.passes(name);
            }
            true
        }
        name => match scan.model.as_mut() {
            None => true,
            Some(model) if tag.closing => model.close(name) != Close::Literal,
            Some(model) => model.open(name, Some(&attributes_of(tag))),
        },
    }
}

fn handles_span(tag: &Tag, scan: &mut Scan, styled: bool) -> bool {
    let Some(model) = scan.model.as_mut() else {
        if tag.closing {
            return scan.spans.pop() == Some(true);
        }
        if !tag.self_closing {
            scan.spans.push(styled);
        }
        return styled;
    };
    if tag.closing {
        return model.close("span") == Close::Closed;
    }
    if styled {
        return model.open("span", Some(&attributes_of(tag)));
    }
    if !tag.self_closing {
        model.push_literal("span");
    }
    false
}
