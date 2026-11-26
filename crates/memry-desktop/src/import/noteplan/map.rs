//! Ports of `packages/importers/src/noteplan/{calendar-dates,convert-body,extract-title,
//! parse-tags,map-properties}.ts`: NotePlan text in, Memry markdown and task rows out. No file
//! system access.

use std::cell::Cell;
use std::collections::HashSet;
use std::sync::LazyLock;

use chrono::NaiveDate;
use memry_core::markdown::frontmatter::{YamlMap, YamlValue, is_js_whitespace, js_trim};
use regex::Regex;

/// `@done(YYYY-MM-DD)`, optionally with a time after a space or `T`.
static DONE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"@done\(([0-9]{4}-[0-9]{2}-[0-9]{2})(?:[ T][^)]*)?\)").expect("valid regex")
});
/// `>YYYY-MM-DD`; the ASCII word boundary after it is checked by hand.
static DUE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r">([0-9]{4}-[0-9]{2}-[0-9]{2})").expect("valid regex"));
/// The body of a `#tag`: letters, numbers, `/`, `-`, `_`.
static TAG_BODY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[\p{L}\p{N}/_-]+").expect("valid regex"));

thread_local! {
    static LINES_SCANNED: Cell<usize> = const { Cell::new(0) };
}

/// Lines this thread's [`convert_body`], [`first_heading`], [`strip_first_heading`] and
/// [`parse_tags`] calls have looked at: each reads every line of its input once.
#[doc(hidden)]
pub fn lines_scanned() -> usize {
    LINES_SCANNED.with(Cell::get)
}

fn lines(text: &str) -> std::str::Split<'_, char> {
    LINES_SCANNED.with(|n| n.set(n.get() + text.split('\n').count()));
    text.split('\n')
}

/// `CalendarFile`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CalendarFile {
    /// A day file: its ISO date.
    Day(String),
    /// A week, month, quarter or year file: its stem, the fallback title.
    Period(String),
}

fn digits(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit())
}

fn number(text: &str) -> u32 {
    text.parse().expect("ASCII digits")
}

/// `isRealDate`: `Date.UTC` maps years 0-99 to 1900-1999, so those never round-trip.
fn is_real_date(year: u32, month: u32, day: u32) -> bool {
    year >= 100 && NaiveDate::from_ymd_opt(year as i32, month, day).is_some()
}

/// `classifyCalendarStem`.
pub fn classify_calendar_stem(stem: &str) -> Option<CalendarFile> {
    let bytes = stem.as_bytes();
    if bytes.len() == 8 && digits(stem) {
        let (y, m, d) = (&stem[..4], &stem[4..6], &stem[6..]);
        return is_real_date(number(y), number(m), number(d))
            .then(|| CalendarFile::Day(format!("{y}-{m}-{d}")));
    }
    let period = || Some(CalendarFile::Period(stem.to_owned()));
    if bytes.len() == 4 && digits(stem) {
        return period();
    }
    if bytes.len() < 5 || !stem.get(..4).is_some_and(digits) || bytes[4] != b'-' {
        return None;
    }
    let tail = &stem[5..];
    match tail.as_bytes() {
        // ISO 8601 weeks run 1 to 53.
        [b'W', a, b]
            if a.is_ascii_digit()
                && b.is_ascii_digit()
                && (1..=53).contains(&number(&tail[1..])) =>
        {
            period()
        }
        [b'Q', b'1'..=b'4'] => period(),
        [a, b] if a.is_ascii_digit() && b.is_ascii_digit() && (1..=12).contains(&number(tail)) => {
            period()
        }
        _ => None,
    }
}

/// `FENCE_RE`: `^\s*(```|~~~)`.
fn is_fence(line: &str) -> bool {
    let rest = line.trim_start_matches(is_js_whitespace);
    rest.starts_with("```") || rest.starts_with("~~~")
}

fn js_trim_end(text: &str) -> &str {
    text.trim_end_matches(is_js_whitespace)
}

/// The title of an H1 line (`H1_RE`, `^#\s+(\S.*)`, then `trimEnd`). Electron's `.` stopped
/// at a CR, U+2028 or U+2029 inside the line; here the title runs to the line's end.
fn heading_title(line: &str) -> Option<&str> {
    let rest = line.strip_prefix('#')?;
    let text = rest.trim_start_matches(is_js_whitespace);
    (text.len() < rest.len() && !text.is_empty()).then(|| js_trim_end(text))
}

/// Index of the first H1 line outside any code fence.
fn heading_line_index(body: &str) -> Option<usize> {
    let mut in_fence = false;
    for (at, line) in lines(body).enumerate() {
        if is_fence(line) {
            in_fence = !in_fence;
        } else if !in_fence && heading_title(line).is_some() {
            return Some(at);
        }
    }
    None
}

/// `firstHeading`.
pub fn first_heading(body: &str) -> Option<String> {
    let at = heading_line_index(body)?;
    let line = body.split('\n').nth(at)?;
    heading_title(line).map(str::to_owned)
}

/// `stripFirstHeading`: drops the H1 line, and the blank line after it.
pub fn strip_first_heading(body: &str) -> String {
    let Some(at) = heading_line_index(body) else {
        return body.to_owned();
    };
    let mut kept: Vec<&str> = lines(body).collect();
    kept.remove(at);
    if kept.get(at) == Some(&"") {
        kept.remove(at);
    }
    kept.join("\n")
}

/// `parseTags`: `#tag` and `#area/tag` outside fences and headings, sorted, no duplicates.
pub fn parse_tags(body: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut in_fence = false;
    for line in lines(body) {
        if is_fence(line) {
            in_fence = !in_fence;
            continue;
        }
        if in_fence || is_heading(line.trim_start_matches(is_js_whitespace)) {
            continue;
        }
        let mut prev: Option<char> = None;
        let mut rest = line;
        while let Some(c) = rest.chars().next() {
            let after = &rest[c.len_utf8()..];
            if c == '#'
                && prev.is_none_or(is_js_whitespace)
                && let Some(tag) = TAG_BODY.find(after)
            {
                seen.insert(tag.as_str().to_owned());
                prev = tag.as_str().chars().last();
                rest = &after[tag.end()..];
                continue;
            }
            prev = Some(c);
            rest = after;
        }
    }
    let mut tags: Vec<String> = seen.into_iter().collect();
    sort_utf16(&mut tags);
    tags
}

/// `HEADING_RE`: one to six `#`, then whitespace.
fn is_heading(line: &str) -> bool {
    let hashes = line.bytes().take_while(|b| *b == b'#').count();
    (1..=6).contains(&hashes) && line[hashes..].starts_with(is_js_whitespace)
}

/// `Array.prototype.toSorted()`: by UTF-16 code units.
pub fn sort_utf16(items: &mut [String]) {
    items.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
}

/// Frontmatter keys that only style a note inside NotePlan.
const STYLING_KEYS: [&str; 5] = [
    "icon",
    "icon-color",
    "bg-color",
    "bg-color-dark",
    "bg-pattern",
];

/// `mapProperties`: every entry but the styling keys, in order.
pub fn map_properties(entries: impl IntoIterator<Item = (String, YamlValue)>) -> YamlMap {
    let mut properties = YamlMap::new();
    for (key, value) in entries {
        if !STYLING_KEYS.contains(&key.as_str()) {
            properties.insert(key, value);
        }
    }
    properties
}

/// `String(value)` for a frontmatter tag. A date becomes its ISO string and a number Rust's
/// shortest form; Electron wrote the local `Date#toString` and `Number#toString`.
pub fn js_string(value: &YamlValue) -> String {
    match value {
        YamlValue::Null => "null".to_owned(),
        YamlValue::Bool(flag) => flag.to_string(),
        YamlValue::Number(n) if *n == 0.0 => "0".to_owned(),
        YamlValue::Number(n) if n.fract() == 0.0 && n.abs() < 1e21 => format!("{n:.0}"),
        YamlValue::Number(n) => n.to_string(),
        YamlValue::String(text) => text.clone(),
        YamlValue::Date(ms) => chrono::DateTime::from_timestamp_millis(*ms)
            .map(|at| at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
            .unwrap_or_else(|| "Invalid Date".to_owned()),
        YamlValue::Binary(bytes) => bytes
            .iter()
            .map(u8::to_string)
            .collect::<Vec<_>>()
            .join(","),
        YamlValue::Seq(items) => items
            .iter()
            .map(|item| match item {
                YamlValue::Null => String::new(),
                other => js_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        YamlValue::Map(_) => "[object Object]".to_owned(),
    }
}

/// `frontmatterTags`: a list's items as strings, or one trimmed string.
pub fn frontmatter_tags(value: Option<&YamlValue>) -> Vec<String> {
    match value {
        Some(YamlValue::Seq(items)) => items
            .iter()
            .map(js_string)
            .filter(|tag| !tag.is_empty())
            .collect(),
        Some(YamlValue::String(tag)) if !js_trim(tag).is_empty() => vec![js_trim(tag).to_owned()],
        _ => Vec::new(),
    }
}

/// `ParsedTask.state`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskState {
    Open,
    Done,
    Cancelled,
}

/// `ParsedTask`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedTask {
    /// `t0`, `t1`, ... within one body.
    pub temp_id: String,
    pub title: String,
    pub state: TaskState,
    pub due_date: Option<String>,
    pub completed_at: Option<String>,
    pub parent_temp_id: Option<String>,
}

/// `ConvertedBody`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConvertedBody {
    pub markdown: String,
    pub tasks: Vec<ParsedTask>,
}

/// `taskPlaceholder`: what a task line ends with until its row exists.
pub fn task_placeholder(temp_id: &str) -> String {
    format!("{{np-task:{temp_id}}}")
}

/// `cutToken`: removes `start..end` and the spaces before it.
fn cut_token(text: &str, start: usize, end: usize) -> String {
    let from = text[..start].trim_end_matches(' ').len();
    format!("{}{}", &text[..from], &text[end..])
}

/// The first `>YYYY-MM-DD` followed by an ASCII word boundary (`DUE_RE`).
fn due_token(text: &str) -> Option<(usize, usize, String)> {
    DUE.captures_iter(text).find_map(|caps| {
        let whole = caps.get(0)?;
        let next = text[whole.end()..].bytes().next();
        let boundary = !next.is_some_and(|b| b.is_ascii_alphanumeric() || b == b'_');
        boundary.then(|| (whole.start(), whole.end(), caps[1].to_owned()))
    })
}

/// `LIST_RE`, `^([ \t]*)([*+-]) +(.*)`: indent, marker and the rest of the line. Electron's
/// `.` stopped at a CR, U+2028 or U+2029; here the rest runs to the line's end, less the CR of
/// a CRLF line.
fn list_item(line: &str) -> Option<(&str, char, &str)> {
    let rest = line.trim_start_matches([' ', '\t']);
    let indent = &line[..line.len() - rest.len()];
    let marker = rest
        .chars()
        .next()
        .filter(|c| matches!(c, '*' | '+' | '-'))?;
    let after = &rest[1..];
    let text = after.trim_start_matches(' ');
    if text.len() == after.len() {
        return None;
    }
    Some((indent, marker, text.strip_suffix('\r').unwrap_or(text)))
}

/// `indentDepth`: a tab or four spaces per level.
fn indent_depth(indent: &str) -> usize {
    let tabs = indent.bytes().filter(|b| *b == b'\t').count();
    tabs + (indent.len() - tabs) / 4
}

/// `STATE_RE`, `^\[([ xX>-])\] *`: the box character and the text after the box.
fn state_box(rest: &str) -> Option<(u8, &str)> {
    match rest.as_bytes() {
        [b'[', state @ (b' ' | b'x' | b'X' | b'>' | b'-'), b']', ..] => {
            Some((*state, rest[3..].trim_start_matches(' ')))
        }
        _ => None,
    }
}

/// `convertBody`: `*` lines become tasks with a placeholder, `+` lines plain checkboxes, `-`
/// lines bullets, each re-indented two spaces a level. Fenced code is kept as is.
pub fn convert_body(source: &str, nested_subtasks: bool) -> ConvertedBody {
    let mut out: Vec<String> = Vec::new();
    let mut tasks = Vec::new();
    // Open tasks by depth: (depth, temp id, parent temp id).
    let mut stack: Vec<(usize, String, Option<String>)> = Vec::new();
    let mut in_fence = false;

    for line in lines(source) {
        if is_fence(line) {
            in_fence = !in_fence;
            out.push(line.to_owned());
            continue;
        }
        let item = if in_fence { None } else { list_item(line) };
        let Some((indent, marker, rest)) = item else {
            out.push(line.to_owned());
            continue;
        };
        let depth = indent_depth(indent);
        let pad = "  ".repeat(depth);
        if marker == '-' {
            out.push(format!("{pad}- {rest}"));
            continue;
        }
        let (state_char, body) = match state_box(rest) {
            Some((state, body)) => (Some(state), body),
            None => (None, rest),
        };
        let checked = matches!(state_char, Some(b'x' | b'X'));
        if marker == '+' {
            out.push(format!(
                "{pad}- [{}] {body}",
                if checked { 'x' } else { ' ' }
            ));
            continue;
        }

        let state = match state_char {
            Some(b'x' | b'X') => TaskState::Done,
            Some(b'-') => TaskState::Cancelled,
            _ => TaskState::Open,
        };
        let mut title = body.to_owned();
        let mut completed_at = None;
        if let Some(caps) = DONE.captures(&title) {
            let whole = caps.get(0).expect("group 0");
            completed_at = Some(caps[1].to_owned());
            title = cut_token(&title, whole.start(), whole.end());
        }
        let mut due_date = None;
        if let Some((start, end, date)) = due_token(&title) {
            due_date = Some(date);
            title = cut_token(&title, start, end);
        }
        let title = js_trim(&title).to_owned();

        while stack.last().is_some_and(|(d, _, _)| *d >= depth) {
            stack.pop();
        }
        let parent_temp_id = stack
            .last()
            .filter(|(_, _, grand)| nested_subtasks || grand.is_none())
            .map(|(_, id, _)| id.clone());
        let temp_id = format!("t{}", tasks.len());
        stack.push((depth, temp_id.clone(), parent_temp_id.clone()));
        let mark = if state == TaskState::Open { ' ' } else { 'x' };
        out.push(format!(
            "{pad}- [{mark}] {title} {}",
            task_placeholder(&temp_id)
        ));
        tasks.push(ParsedTask {
            temp_id,
            title,
            state,
            due_date,
            completed_at,
            parent_temp_id,
        });
    }
    ConvertedBody {
        markdown: out.join("\n"),
        tasks,
    }
}
