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
    /// Whether the line above opened a list item.
    after_item: bool,
    /// Whether the line above is a row of a table.
    in_table: bool,
}

impl Scan {
    pub(super) fn new(markdown: bool) -> Self {
        Self {
            model: markdown.then(HtmlNesting::default),
            after_item: false,
            in_table: false,
        }
    }

    /// A blank line, a line that starts an HTML block, and a list item or a
    /// table row, as the model reads them. `next` is the line below, which
    /// tells a table's header row from a line with a pipe in it. Says whether
    /// `line` is a row of a table, whose cells each end the marks opened in them.
    pub(super) fn line(&mut self, line: &str, next: Option<&str>) -> bool {
        let Some(model) = self.model.as_mut() else {
            return false;
        };
        let row = line.contains('|') && (self.in_table || next.is_some_and(is_delimiter_row));
        let mut item = false;
        if crate::domain::journal_rules::js_trim(line).is_empty() {
            model.blank_line();
        } else if starts_html_block(line) {
            model.html_block_line();
        } else if row {
            model.end_paragraph();
        } else {
            item = opens_list_item(line, self.after_item);
            if item {
                model.end_paragraph();
            }
        }
        self.after_item = item;
        self.in_table = row;
        row
    }

    /// A line in a fence: no table, no item, and a table above it is over.
    pub(super) fn fenced(&mut self) {
        self.after_item = false;
        self.in_table = false;
    }
}

/// `opensListItem`: whether `line` opens a list item that ends the paragraph
/// above it: a bullet or a number, behind any block quote markers and up to
/// three spaces. A number only interrupts a paragraph when it is 1, and one
/// after another item is an item whatever it is; an item with more indent is
/// the item above's own text, and is left to count with it.
fn opens_list_item(line: &str, after_item: bool) -> bool {
    let bytes = line.as_bytes();
    let at_blank = |at: usize| matches!(bytes.get(at), Some(b' ' | b'\t'));
    let mut at = 0;
    loop {
        let mut next = at;
        while next - at < 3 && bytes.get(next) == Some(&b' ') {
            next += 1;
        }
        if bytes.get(next) != Some(&b'>') {
            break;
        }
        at = next + 1;
        if at_blank(at) {
            at += 1;
        }
    }
    let mut marker = at;
    while bytes.get(marker) == Some(&b' ') {
        marker += 1;
    }
    if marker - at > 3 {
        return false;
    }
    if matches!(bytes.get(marker), Some(b'-' | b'*' | b'+')) {
        return at_blank(marker + 1);
    }
    let mut end = marker;
    while end - marker < 10 && bytes.get(end).is_some_and(u8::is_ascii_digit) {
        end += 1;
    }
    let digits = end - marker;
    if digits == 0 || digits > 9 || !matches!(bytes.get(end), Some(b'.' | b')')) {
        return false;
    }
    at_blank(end + 1) && (after_item || line[marker..end].parse::<u32>() == Ok(1))
}

/// `isDelimiterRow`: the row under a table's header, cells of dashes with a
/// colon at either end.
fn is_delimiter_row(line: &str) -> bool {
    if !line.contains('|') {
        return false;
    }
    let mut cells = crate::domain::journal_rules::js_trim(line);
    cells = cells.strip_prefix('|').unwrap_or(cells);
    cells = cells.strip_suffix('|').unwrap_or(cells);
    cells.split('|').all(|cell| {
        let cell = cell.trim_matches([' ', '\t']);
        let dashes = cell.strip_prefix(':').unwrap_or(cell);
        let dashes = dashes.strip_suffix(':').unwrap_or(dashes);
        !dashes.is_empty() && dashes.bytes().all(|b| b == b'-')
    })
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
/// otherwise read: a tag of [`HANDLED`], a checkbox, a span of any kind (one
/// with a `style` is a colour, and a plain one takes the `</span>` that ends a
/// coloured run). A toggle's `<details>` is left as it is: it pairs with its
/// `</details>` across lines, and an unterminated one is pinned as the text it
/// is.
pub(super) fn reads_as_markup(tag: &Tag) -> bool {
    match tag.name.as_str() {
        "span" => true,
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

/// Whether the editor handles `tag` in a note, within the nesting cap. A
/// `</span>` belongs to the innermost `<span>` that is open, and one closing a
/// plain span, or nothing, is text.
pub(super) fn is_handled(tag: &Tag, model: &mut HtmlNesting) -> bool {
    let has = |name: &str| tag.attrs.iter().any(|(attr, _)| attr == name);
    match tag.name.as_str() {
        "span" => handles_span(tag, model, has("style")),
        "details" => {
            if tag.closing {
                model.close("details");
            }
            !tag.closing && has("data-memry-toggle") && model.open("details", None)
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
            model.passes(name);
            true
        }
        name if tag.closing => model.close(name) != Close::Literal,
        name => model.open(name, Some(&attributes_of(tag))),
    }
}

fn handles_span(tag: &Tag, model: &mut HtmlNesting, styled: bool) -> bool {
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
