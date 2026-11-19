//! `packages/importers/src/roam/*`: a parsed Roam graph to one planned note per page.
//!
//! Every block uid is indexed first (`index-blocks.ts`), then each page's outline becomes a
//! nested bullet list with Roam markup scrubbed (`convert-blocks.ts`), its `((uid))` references
//! are resolved against the index (`resolve-refs.ts`), and a daily page is retitled to its
//! journal date (`dates.ts`, `map-pages.ts`).
//!
//! The pages are the values `JSON.parse` gave, so each field is read with the JavaScript
//! semantics of the TypeScript mapper. A shape on which that mapper throws a `TypeError` fails
//! the whole mapping, as it failed Electron's run.

use std::cell::Cell;
use std::collections::HashMap;
use std::sync::LazyLock;

use chrono::NaiveDate;
use regex::{Captures, Regex};
use tokio_util::sync::CancellationToken;

use crate::web::extract::utils::date::iso_string;
use crate::web::extract::utils::js::{self, is_js_whitespace};
use crate::web::extract::utils::json::JsValue;

const ROOT: &str = "Roam";
const INDENT: &str = "  ";

/// JavaScript's regex `\s`.
const WS: &str = r"[\t\n\x0B\x0C\r \u{A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}]";
/// JavaScript's regex `.`: anything but a line terminator.
const DOT: &str = r"[^\n\r\u{2028}\u{2029}]";

fn re(pattern: &str) -> Regex {
    Regex::new(&pattern.replace("\\s", WS).replace("<dot>", DOT)).expect("valid Roam regex")
}

static TODO: LazyLock<[Regex; 4]> = LazyLock::new(|| {
    [
        re(r"\{\{\[\[TODO\]\]\}\}\s*"),
        re(r"\{\{TODO\}\}\s*"),
        re(r"\{\{\[\[DONE\]\]\}\}\s*"),
        re(r"\{\{DONE\}\}\s*"),
    ]
});
static ITALIC: LazyLock<Regex> = LazyLock::new(|| re(r"__(<dot>+?)__"));
static HIGHLIGHT: LazyLock<Regex> = LazyLock::new(|| re(r"\^\^(<dot>+?)\^\^"));
static EMBED: LazyLock<Regex> =
    LazyLock::new(|| re(r"\{\{\[?\[?embed\]?\]?:\s*\(\(([^)]+)\)\)\s*\}\}"));
static TEMPLATE: LazyLock<Regex> = LazyLock::new(|| re(r"\{\{[^}]*\}\}"));
static REF: LazyLock<Regex> =
    LazyLock::new(|| re(r"\{\{embed:\(\(([^)(]+)\)\)\}\}|\(\(([^)(]+)\)\)"));
static LONG_DATE: LazyLock<Regex> =
    LazyLock::new(|| re(r"^([A-Za-z]+)\s+([0-9]{1,2})(?:st|nd|rd|th)?,\s*([0-9]{4})$"));
static UID_DATE: LazyLock<Regex> = LazyLock::new(|| re(r"^([0-9]{2})-([0-9]{2})-([0-9]{4})$"));

const MONTHS: [&str; 12] = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
];

thread_local! {
    static QUOTED_BYTES: Cell<usize> = const { Cell::new(0) };
}

/// Bytes of referenced block text this thread has scrubbed to quote a block reference.
#[doc(hidden)]
pub fn quoted_bytes_scrubbed() -> usize {
    QUOTED_BYTES.with(Cell::get)
}

/// `NotePlan`: one page as the note it becomes.
#[derive(Debug, Clone, PartialEq)]
pub struct NotePlan {
    pub title: String,
    pub body: String,
    /// `Roam`, or `Roam/A/B` for a page titled `A/B/C`.
    pub folder: String,
    pub created: Option<String>,
    pub modified: Option<String>,
    pub is_daily_note: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum MapError {
    /// A value the TypeScript mapper threw on.
    Shape(&'static str),
    /// The notes would hold more than the budget: refused before anything is written.
    TooLarge,
    Cancelled,
}

/// `scrubMarkup`: Roam inline markup to Memry markdown; block references stay for phase 3.
pub fn scrub_markup(input: &str) -> String {
    let mut out = input.to_owned();
    for (at, pattern) in TODO.iter().enumerate() {
        let mark = if at < 2 { "[ ] " } else { "[x] " };
        out = pattern.replace_all(&out, mark).into_owned();
    }
    out = ITALIC.replace_all(&out, "*$1*").into_owned();
    out = HIGHLIGHT.replace_all(&out, "==$1==").into_owned();
    out = EMBED
        .replace_all(&out, |c: &Captures| format!("{{{{embed:(({}))}}}}", &c[1]))
        .into_owned();
    drop_templates(&out)
}

/// `/\{\{(?!embed:)[^}]*\}\}/g` → ''. A match that starts with `{{embed:` fails the lookahead,
/// so the search goes on one character later.
fn drop_templates(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let (mut copied, mut from) = (0, 0);
    while let Some(m) = TEMPLATE.find_at(text, from) {
        if text[m.start()..].starts_with("{{embed:") {
            from = m.start() + 1;
            continue;
        }
        out.push_str(&text[copied..m.start()]);
        copied = m.end();
        from = m.end();
    }
    out.push_str(&text[copied..]);
    out
}

/// One entry of a `children` value as `for (const block of children)` sees it.
#[derive(Clone, Copy)]
enum Child<'a> {
    Block(&'a JsValue),
    /// A string, number or array: no uid, no text, no children.
    Empty,
}

/// `children ?? []` iterated with `for…of`.
fn children(value: Option<&JsValue>) -> Result<Vec<Child<'_>>, MapError> {
    match value {
        None | Some(JsValue::Null) => Ok(Vec::new()),
        // A string iterates by code point.
        Some(JsValue::String(s)) => Ok(vec![Child::Empty; s.chars().count()]),
        Some(JsValue::Array(items)) => items
            .iter()
            .map(|item| match item {
                JsValue::Null => Err(MapError::Shape("Cannot read properties of null")),
                JsValue::Object(_) => Ok(Child::Block(item)),
                _ => Ok(Child::Empty),
            })
            .collect(),
        Some(_) => Err(MapError::Shape("children is not iterable")),
    }
}

/// `block.string ?? ''`, which `scrubMarkup` needs to be a string.
fn block_text(block: Child<'_>) -> Result<&str, MapError> {
    match block {
        Child::Empty => Ok(""),
        Child::Block(value) => match value.get("string") {
            None | Some(JsValue::Null) => Ok(""),
            Some(JsValue::String(s)) => Ok(s),
            Some(_) => Err(MapError::Shape("A block's text is not a string")),
        },
    }
}

fn field<'a>(block: Child<'a>, key: &str) -> Option<&'a JsValue> {
    match block {
        Child::Block(value) => value.get(key),
        Child::Empty => None,
    }
}

/// `headingPrefix(block.heading)`.
fn heading_prefix(level: Option<&JsValue>) -> String {
    let Some(level) = level.filter(|l| l.truthy()) else {
        return String::new();
    };
    let n = match level {
        JsValue::Array(_) => js::to_number(&level.to_js_string()),
        _ => level.to_number(),
    };
    if n < 1.0 || n.is_nan() {
        return String::new();
    }
    "#".repeat(n.min(6.0) as usize) + " "
}

/// Walks a page's blocks depth first, in document order, without recursion.
fn walk<'a>(
    top: Option<&'a JsValue>,
    mut visit: impl FnMut(Child<'a>, usize) -> Result<(), MapError>,
) -> Result<(), MapError> {
    let mut stack: Vec<(Child<'a>, usize)> =
        children(top)?.into_iter().rev().map(|c| (c, 0)).collect();
    while let Some((block, depth)) = stack.pop() {
        visit(block, depth)?;
        let kids = children(field(block, "children"))?;
        stack.extend(kids.into_iter().rev().map(|c| (c, depth + 1)));
    }
    Ok(())
}

/// `indexBlocks`: uid → (page title, raw text); the last block of a uid wins.
type Index<'a> = HashMap<&'a str, (&'a str, &'a str)>;

fn index_blocks(pages: &[JsValue]) -> Result<Index<'_>, MapError> {
    let mut index = Index::new();
    for page in pages {
        let title = page.get("title").and_then(JsValue::as_str).unwrap_or("");
        walk(page.get("children"), |block, _| {
            if let Some(uid) = field(block, "uid").and_then(JsValue::as_str)
                && !uid.is_empty()
            {
                index.insert(uid, (title, block_text(block).unwrap_or("")));
            }
            Ok(())
        })?;
    }
    Ok(index)
}

/// Counts the bytes the notes would hold against the run's budget.
struct Budget(usize);

impl Budget {
    fn spend(&mut self, bytes: usize) -> Result<(), MapError> {
        self.0 = self.0.checked_sub(bytes).ok_or(MapError::TooLarge)?;
        Ok(())
    }
}

/// `convertBlocks`.
fn convert_blocks(top: Option<&JsValue>, budget: &mut Budget) -> Result<String, MapError> {
    let mut lines: Vec<String> = Vec::new();
    walk(top, |block, depth| {
        let text = heading_prefix(field(block, "heading")) + &scrub_markup(block_text(block)?);
        let line = format!("{}- {text}", INDENT.repeat(depth));
        let line = line.trim_end_matches(is_js_whitespace).to_owned();
        budget.spend(line.len() + 1)?;
        lines.push(line);
        Ok(())
    })?;
    Ok(lines.join("\n"))
}

/// `resolveRefs`: one pass, so text a reference brings in is not scanned again. Each
/// referenced block is quoted once per run.
fn resolve_refs<'a>(
    markdown: &str,
    index: &Index<'a>,
    quoted: &mut HashMap<&'a str, String>,
    budget: &mut Budget,
) -> Result<String, MapError> {
    let mut out = String::with_capacity(markdown.len());
    let mut copied = 0;
    for caps in REF.captures_iter(markdown) {
        let whole = caps.get(0).expect("group 0");
        let uid = caps.get(1).or_else(|| caps.get(2)).expect("one uid group");
        out.push_str(&markdown[copied..whole.start()]);
        copied = whole.end();
        let rendered = match index.get_key_value(uid.as_str()) {
            None => uid.as_str(),
            Some((&key, &(page, text))) => quoted.entry(key).or_insert_with(|| {
                QUOTED_BYTES.with(|n| n.set(n.get() + text.len()));
                let clean = scrub_markup(text);
                let clean = js::split_whitespace_runs(&clean).join(" ");
                let clean = js::trim(&clean);
                if clean.is_empty() {
                    format!("[[{page}]]")
                } else {
                    format!("[[{page}]]: \"{clean}\"")
                }
            }),
        };
        budget.spend(rendered.len())?;
        out.push_str(rendered);
    }
    out.push_str(&markdown[copied..]);
    Ok(out)
}

/// `toIso`: a real Gregorian date. `Date.UTC` reads years 0-99 as 1900-1999, so those never
/// match.
fn to_iso(year: i32, month: u32, day: u32) -> Option<String> {
    (year >= 100 && NaiveDate::from_ymd_opt(year, month, day).is_some())
        .then(|| format!("{year:04}-{month:02}-{day:02}"))
}

/// `parseDailyNoteTitle`: `January 1st, 2024` → `2024-01-01`.
pub fn parse_daily_note_title(title: &str) -> Option<String> {
    let caps = LONG_DATE.captures(js::trim(title))?;
    let name = caps[1].to_ascii_lowercase();
    let month = MONTHS.iter().position(|m| *m == name)? as u32 + 1;
    to_iso(caps[3].parse().ok()?, month, caps[2].parse().ok()?)
}

/// `detectDailyNote`: the title wins over the uid (`MM-DD-YYYY`). A truthy uid that is not a
/// string is a `TypeError` (`uid.match`).
fn detect_daily_note(title: &str, uid: Option<&JsValue>) -> Result<Option<String>, MapError> {
    if let Some(iso) = parse_daily_note_title(title) {
        return Ok(Some(iso));
    }
    match uid {
        Some(JsValue::String(uid)) => Ok(UID_DATE.captures(uid).and_then(|caps| {
            to_iso(
                caps[3].parse().ok()?,
                caps[1].parse().ok()?,
                caps[2].parse().ok()?,
            )
        })),
        Some(value) if value.truthy() => Err(MapError::Shape("A page uid is not a string")),
        _ => Ok(None),
    }
}

/// `splitTitlePath`: `A/B/C` → folder `Roam/A/B`, title `C`; empty segments are dropped.
pub fn split_title_path(title: &str) -> (String, String) {
    let segments: Vec<&str> = title
        .split('/')
        .map(js::trim)
        .filter(|s| !s.is_empty())
        .collect();
    match segments.split_last() {
        Some((leaf, parents)) if !parents.is_empty() => {
            (format!("{ROOT}/{}", parents.join("/")), (*leaf).to_owned())
        }
        _ => {
            let trimmed = js::trim(title);
            let leaf = if trimmed.is_empty() { title } else { trimmed };
            (ROOT.to_owned(), leaf.to_owned())
        }
    }
}

/// `msToIso`: a JSON number within the `Date` range, else none.
fn ms_to_iso(value: Option<&JsValue>) -> Option<String> {
    match value {
        Some(JsValue::Number(ms)) => iso_string(Some(*ms)).ok(),
        _ => None,
    }
}

/// `mapPages` over pages that each have a string title, holding at most `max_bytes` of note
/// bodies.
pub fn map_pages(
    pages: &[JsValue],
    max_bytes: usize,
    cancel: &CancellationToken,
) -> Result<Vec<NotePlan>, MapError> {
    let index = index_blocks(pages)?;
    let mut quoted = HashMap::new();
    let mut budget = Budget(max_bytes);
    let mut plans = Vec::with_capacity(pages.len());
    for page in pages {
        if cancel.is_cancelled() {
            return Err(MapError::Cancelled);
        }
        let title = page.get("title").and_then(JsValue::as_str).unwrap_or("");
        let daily = detect_daily_note(title, page.get("uid"))?;
        let converted = convert_blocks(page.get("children"), &mut budget)?;
        let body = resolve_refs(&converted, &index, &mut quoted, &mut budget)?;
        let (folder, title) = match &daily {
            Some(iso) => (ROOT.to_owned(), iso.clone()),
            None => split_title_path(title),
        };
        plans.push(NotePlan {
            title,
            body,
            folder,
            created: ms_to_iso(page.get("create-time")),
            modified: ms_to_iso(page.get("edit-time")),
            is_daily_note: daily.is_some(),
        });
    }
    Ok(plans)
}
