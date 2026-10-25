//! `inline/emphasis-runs.ts`: BlockNote writes every text run in its own
//! marks, so a run of bold or italic is turned into one open and one close
//! token around the run, and the tokens become delimiters after the
//! serializer ran. Code spans, link breaks and link addresses travel as tokens
//! too, so the serializer escapes none of their bytes.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value as Json};

use crate::markdown::convert::ConvertError;
use crate::markdown::frontmatter::js::is_js_whitespace;
use crate::markdown::schema::link_code_spans::code_span_ranges;
use crate::markdown::shared::html_comments::random_process_word;

/// A token's meaning: a mark around a run, or a code span's own bytes.
#[derive(Debug, Clone)]
pub enum Span {
    Mark(&'static str),
    Code(String),
}

const MARKS: [(&str, &str); 3] = [("bold", "**"), ("italic", "*"), ("strike", "~~")];

/// Per process, so note text does not hold a token (BBF-30).
static PROCESS_WORD: LazyLock<String> = LazyLock::new(random_process_word);

fn open_token(index: usize) -> String {
    format!("MEMRYEMO{}{index};", *PROCESS_WORD)
}

fn close_token(index: usize) -> String {
    format!("MEMRYEMC{}{index};", *PROCESS_WORD)
}

fn code_token(index: usize) -> String {
    format!("MEMRYEMK{}{index};", *PROCESS_WORD)
}

static TOKEN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"MEMRYEM([OCK]){}(\d+);", *PROCESS_WORD)).expect("static pattern")
});

fn push_mark(marks: &mut Vec<Span>, span: Span) -> usize {
    marks.push(span);
    marks.len() - 1
}

fn text_of(item: &Json) -> Option<&str> {
    item.get("text").and_then(Json::as_str)
}

fn holds(item: &Json, mark: &str) -> bool {
    if let Some(content) = item.get("content").and_then(Json::as_array) {
        return !content.is_empty() && content.iter().all(|c| holds(c, mark));
    }
    if item.get("type").and_then(Json::as_str) == Some("text") {
        return item.get("styles").and_then(|s| s.get(mark)) == Some(&Json::Bool(true))
            && text_of(item) != Some("");
    }
    item.get("props").and_then(|s| s.get(mark)) == Some(&Json::Bool(true))
}

fn without(item: &Json, mark: &str) -> Json {
    let mut next = item.clone();
    if let Some(content) = item.get("content").and_then(Json::as_array) {
        next["content"] = Json::Array(content.iter().map(|c| without(c, mark)).collect());
        return next;
    }
    let key = if item.get("type").and_then(Json::as_str) == Some("text") {
        "styles"
    } else {
        "props"
    };
    if let Some(map) = next.get_mut(key).and_then(Json::as_object_mut) {
        map.shift_remove(mark);
    }
    next
}

fn run_length(items: &[Json], from: usize, mark: &str) -> usize {
    items[from..].iter().take_while(|i| holds(i, mark)).count()
}

fn styles_of(item: &Json) -> Vec<(String, Json)> {
    let mut entries: Vec<(String, Json)> = item
        .get("styles")
        .and_then(Json::as_object)
        .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default();
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    entries
}

fn is_text(item: &Json) -> bool {
    item.get("type").and_then(Json::as_str) == Some("text")
}

/// Adjacent text of equal styles, joined: BlockNote writes each text run of a
/// link as its own link (BBF-71).
fn join_texts(items: Vec<Json>) -> Vec<Json> {
    let mut out: Vec<Json> = Vec::new();
    for item in items {
        if let Some(last) = out.last_mut()
            && is_text(&item)
            && is_text(last)
            && styles_of(last) == styles_of(&item)
        {
            let joined = format!(
                "{}{}",
                text_of(last).unwrap_or(""),
                text_of(&item).unwrap_or("")
            );
            last["text"] = Json::String(joined);
            continue;
        }
        out.push(item);
    }
    out
}

/// `text.split(/(\n+)/)`: the runs of newlines and what lies between them.
fn split_newline_runs(text: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut start = 0;
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\n' {
            let mut j = i;
            while j < bytes.len() && bytes[j] == b'\n' {
                j += 1;
            }
            parts.push(&text[start..i]);
            parts.push(&text[i..j]);
            start = j;
            i = j;
        } else {
            i += 1;
        }
    }
    parts.push(&text[start..]);
    parts
}

/// A link whose text holds a break, one link per line, the break outside (BBF-104).
fn split_links_at_breaks(items: Vec<Json>) -> Result<Vec<Json>, ConvertError> {
    let mut out = Vec::new();
    for item in items {
        let content = item.get("content").and_then(Json::as_array).cloned();
        // `content?.some(...)` throws on a link whose content is not an array.
        if item.get("type").and_then(Json::as_str) == Some("link")
            && item
                .get("content")
                .is_some_and(|c| !c.is_null() && !c.is_array())
        {
            return Err(ConvertError::Serialize(
                "link content is not an array".into(),
            ));
        }
        let splits = item.get("type").and_then(Json::as_str) == Some("link")
            && content.as_ref().is_some_and(|c| {
                c.iter()
                    .any(|child| text_of(child).is_some_and(|t| t.contains('\n')))
            });
        if !splits {
            out.push(item);
            continue;
        }
        let mut line: Vec<Json> = Vec::new();
        let end_line = |line: &mut Vec<Json>, out: &mut Vec<Json>| {
            if !line.is_empty() {
                let mut link = item.clone();
                link["content"] = Json::Array(std::mem::take(line));
                out.push(link);
            }
        };
        for child in content.into_iter().flatten() {
            for part in split_newline_runs(text_of(&child).unwrap_or("")) {
                if part.is_empty() {
                    continue;
                }
                let mut piece = child.clone();
                piece["text"] = Json::String(part.to_owned());
                if !part.starts_with('\n') {
                    line.push(piece);
                    continue;
                }
                end_line(&mut line, &mut out);
                if let Some(styles) = piece.get_mut("styles").and_then(Json::as_object_mut) {
                    styles.shift_remove("code");
                } else if child.get("styles").is_none() {
                    piece["styles"] = Json::Object(Map::new());
                }
                out.push(piece);
            }
            if !is_text(&child) {
                line.push(child);
            }
        }
        end_line(&mut line, &mut out);
    }
    Ok(out)
}

/// Each soft break in a list item's link text, as a token inside the link (BBF-106).
pub fn list_link_break_tokens(items: Vec<Json>, marks: &mut Vec<Span>) -> Vec<Json> {
    items
        .into_iter()
        .map(|mut item| {
            if item.get("type").and_then(Json::as_str) != Some("link") {
                return item;
            }
            let Some(content) = item.get("content").and_then(Json::as_array).cloned() else {
                return item;
            };
            let content: Vec<Json> = content
                .into_iter()
                .map(|mut child| {
                    if let Some(text) = text_of(&child).filter(|t| t.contains('\n')) {
                        let chars: Vec<char> = text.chars().collect();
                        let mut out = String::new();
                        for (i, c) in chars.iter().enumerate() {
                            let single = *c == '\n'
                                && (i == 0 || chars[i - 1] != '\n')
                                && chars.get(i + 1) != Some(&'\n');
                            if single {
                                out.push_str(&code_token(push_mark(
                                    marks,
                                    Span::Code("\n".into()),
                                )));
                            } else {
                                out.push(*c);
                            }
                        }
                        child["text"] = Json::String(out);
                    }
                    child
                })
                .collect();
            item["content"] = Json::Array(content);
            item
        })
        .collect()
}

/// A code span in link text is the link's own text; each travels as a token (BBF-105).
fn code_tokens(items: Vec<Json>, marks: &mut Vec<Span>) -> Vec<Json> {
    items
        .into_iter()
        .map(|mut item| {
            let Some(text) = text_of(&item).filter(|t| t.contains('`')) else {
                return item;
            };
            if !is_text(&item)
                || item.get("styles").and_then(|s| s.get("code")) == Some(&Json::Bool(true))
            {
                return item;
            }
            let mut units: Vec<u16> = text.encode_utf16().collect();
            for (at, length) in code_span_ranges(text).into_iter().rev() {
                let code = String::from_utf16_lossy(&units[at..at + length]);
                let token = code_token(push_mark(marks, Span::Code(code)));
                units.splice(at..at + length, token.encode_utf16());
            }
            item["text"] = Json::String(String::from_utf16_lossy(&units));
            item
        })
        .collect()
}

fn is_href_special(c: char) -> bool {
    matches!(c, '\\' | '(' | ')' | '<' | '>') || is_js_whitespace(c)
}

/// A link address whose parentheses balance is valid as written, so it travels
/// as tokens (BBF-107 to BBF-109).
fn href_paren_tokens(mut item: Json, marks: &mut Vec<Span>) -> Json {
    if item.get("type").and_then(Json::as_str) != Some("link") {
        return item;
    }
    let Some(href) = item
        .get("href")
        .and_then(Json::as_str)
        .filter(|h| !h.is_empty())
    else {
        return item;
    };
    if !href.chars().any(is_href_special) {
        return item;
    }
    if href != crate::markdown::frontmatter::js::js_trim(href) || href.contains('\n') {
        return item;
    }
    if !href.chars().any(is_js_whitespace) && href.starts_with('<') {
        return item;
    }
    let chars: Vec<char> = href.chars().collect();
    let mut depth: i64 = 0;
    let mut at = 0;
    while at < chars.len() {
        match chars[at] {
            '\\' => {
                at += 1;
                if at == chars.len() {
                    return item;
                }
            }
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth < 0 {
                    return item;
                }
            }
            _ => {}
        }
        at += 1;
    }
    if depth != 0 {
        return item;
    }
    let mut out = String::new();
    for c in chars {
        if is_href_special(c) {
            out.push_str(&code_token(push_mark(marks, Span::Code(c.to_string()))));
        } else {
            out.push(c);
        }
    }
    item["href"] = Json::String(out);
    item
}

/// `items` with every run of a mark between tokens; `marks` maps each token to its span.
pub fn tokenize_emphasis_runs(
    items: Vec<Json>,
    marks: &mut Vec<Span>,
) -> Result<Vec<Json>, ConvertError> {
    let items = split_links_at_breaks(items)?;
    let mut out = Vec::new();
    let mut at = 0;
    while at < items.len() {
        let mut best: Option<(&'static str, usize)> = None;
        for (mark, _) in MARKS {
            let length = run_length(&items, at, mark);
            if length > 0 && length > best.map_or(0, |b| b.1) {
                best = Some((mark, length));
            }
        }
        let Some((mark, length)) = best else {
            let item = items[at].clone();
            at += 1;
            if let Some(children) = item.get("content").and_then(Json::as_array).cloned() {
                let mut next = href_paren_tokens(item, marks);
                let coded = code_tokens(children, marks);
                next["content"] = Json::Array(join_texts(tokenize_emphasis_runs(coded, marks)?));
                out.push(next);
            } else {
                out.push(item);
            }
            continue;
        };
        let index = push_mark(marks, Span::Mark(mark));
        let run: Vec<Json> = items[at..at + length]
            .iter()
            .map(|i| without(i, mark))
            .collect();
        out.push(serde_json::json!({"type": "text", "text": open_token(index), "styles": {}}));
        out.extend(tokenize_emphasis_runs(run, marks)?);
        out.push(serde_json::json!({"type": "text", "text": close_token(index), "styles": {}}));
        at += length;
    }
    Ok(out)
}

fn edge_len_front(chars: &[char]) -> usize {
    let mut i = 0;
    loop {
        if chars.get(i) == Some(&'\\') && chars.get(i + 1) == Some(&'\n') {
            i += 2;
        } else if chars.get(i).is_some_and(|c| is_js_whitespace(*c)) {
            i += 1;
        } else {
            return i;
        }
    }
}

fn edge_len_back(chars: &[char], floor: usize) -> usize {
    let mut i = chars.len();
    while i > floor {
        if i >= floor + 2 && chars[i - 2] == '\\' && chars[i - 1] == '\n' {
            i -= 2;
        } else if is_js_whitespace(chars[i - 1]) {
            i -= 1;
        } else {
            break;
        }
    }
    chars.len() - i
}

/// Each token pair in `markdown` turned into its delimiters.
pub fn restore_emphasis_runs(markdown: &str, marks: &[Span]) -> String {
    let mut open: Vec<String> = vec![String::new()];
    let mut last = 0;
    for token in TOKEN.captures_iter(markdown) {
        let whole = token.get(0).expect("whole match");
        open.last_mut()
            .expect("open is never empty")
            .push_str(&markdown[last..whole.start()]);
        last = whole.end();
        let span = token[2].parse::<usize>().ok().and_then(|i| marks.get(i));
        match &token[1] {
            "K" => {
                if let Some(Span::Code(code)) = span {
                    open.last_mut().expect("open is never empty").push_str(code);
                }
            }
            "O" => open.push(String::new()),
            _ => {
                if open.len() == 1 {
                    continue;
                }
                let run = open.pop().expect("checked above");
                let delimiter = match span {
                    Some(Span::Mark(m)) => {
                        MARKS.iter().find(|(n, _)| n == m).map_or("", |(_, d)| d)
                    }
                    _ => "",
                };
                let chars: Vec<char> = run.chars().collect();
                let before = edge_len_front(&chars);
                let after = edge_len_back(&chars, before);
                let content: String = chars[before..chars.len() - after].iter().collect();
                let target = open.last_mut().expect("open is never empty");
                if content.is_empty() {
                    target.push_str(&run);
                } else {
                    let b: String = chars[..before].iter().collect();
                    let a: String = chars[chars.len() - after..].iter().collect();
                    target.push_str(&format!("{b}{delimiter}{content}{delimiter}{a}"));
                }
            }
        }
    }
    // A pair the serializer cut short keeps its text, without delimiters.
    open.concat() + &markdown[last..]
}
