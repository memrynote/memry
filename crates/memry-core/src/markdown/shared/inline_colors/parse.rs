//! Parse side of `inline-colors.ts`: mask `<span style="…">` tags into tokens
//! before the markdown parse, then turn the tokens back into styles on the
//! parsed inline runs.

use serde_json::{Map, Value as Json, json};

use super::{
    CLOSE_TOKEN, cell_inline_content, is_safe_color_value, is_table_content, open_token,
    with_cell_content,
};
use crate::markdown::frontmatter::js::js_trim;
use crate::markdown::shared::block_colors::js_value::{
    js_trim_start, order_keys, prop, spread_all,
};

const SPAN_OPEN_PREFIX: &str = "<span style=\"";
const SPAN_CLOSE: &str = "</span>";

/// `MaskedColorSpan`: the styles a masked open tag carries and its source text.
/// `styles` keeps the key order the declarations were read in.
#[derive(Debug, Clone, PartialEq)]
pub struct MaskedColorSpan {
    pub styles: Map<String, Json>,
    pub source: String,
}

impl MaskedColorSpan {
    pub fn to_json(&self) -> Json {
        json!({"styles": self.styles, "source": self.source})
    }

    /// Reads `{styles, source}`; `None` for any other shape.
    pub fn from_json(value: &Json) -> Option<Self> {
        Some(Self {
            styles: prop(value, "styles")?.as_object()?.clone(),
            source: prop(value, "source")?.as_str()?.to_owned(),
        })
    }
}

/// The result of [`mask_inline_color_spans`].
#[derive(Debug, Clone, PartialEq)]
pub struct MaskedColorText {
    pub text: String,
    pub spans: Vec<MaskedColorSpan>,
}

/// The span tags `/<span style="([^"]*)">/g` finds: `(start, end, style)`.
fn span_open_matches(text: &str) -> Vec<(usize, usize, &str)> {
    let mut found = Vec::new();
    let mut from = 0;
    while let Some(at) = text[from..].find(SPAN_OPEN_PREFIX) {
        let start = from + at;
        let style_start = start + SPAN_OPEN_PREFIX.len();
        let closing = text[style_start..].find('"').map(|q| style_start + q);
        match closing {
            Some(quote) if text[quote + 1..].starts_with('>') => {
                found.push((start, quote + 2, &text[style_start..quote]));
                from = quote + 2;
            }
            _ => from = start + 1,
        }
    }
    found
}

/// `parseColorDecls`: the styles of a `style` attribute made only of the
/// declarations Memry writes, or `None`.
fn parse_color_decls(style: &str) -> Option<Map<String, Json>> {
    let mut colors = Map::new();
    for decl in style.split(';') {
        if js_trim(decl).is_empty() {
            continue;
        }
        let colon = decl.find(':')?;
        let property = js_trim(&decl[..colon]);
        let value = js_trim(&decl[colon + 1..]);
        if !is_safe_color_value(value) {
            return None;
        }
        match property {
            "color" => colors.insert("textColor".to_owned(), json!(value)),
            "background-color" => colors.insert("backgroundColor".to_owned(), json!(value)),
            "text-decoration" if value.to_lowercase() == "underline" => {
                colors.insert("underline".to_owned(), Json::Bool(true))
            }
            _ => return None,
        };
    }
    (!colors.is_empty()).then_some(colors)
}

fn mask_segment(segment: &str, spans: &mut Vec<MaskedColorSpan>) -> String {
    let mut masked = String::with_capacity(segment.len());
    let mut last = 0;
    for (start, end, style) in span_open_matches(segment) {
        masked.push_str(&segment[last..start]);
        let source = &segment[start..end];
        match parse_color_decls(style) {
            Some(styles) => {
                spans.push(MaskedColorSpan {
                    styles,
                    source: source.to_owned(),
                });
                masked.push_str(&open_token(spans.len() - 1));
            }
            None => masked.push_str(source),
        }
        last = end;
    }
    masked.push_str(&segment[last..]);
    masked.replace(SPAN_CLOSE, CLOSE_TOKEN)
}

/// The inline code spans `` /(`+)[^`]*?\1/g `` finds, as byte ranges. A run of
/// `k` backticks matches the next run of at least `k`; when there is none, the
/// regex backtracks to `floor(k / 2)` backticks closed by the rest of the run.
fn inline_code_matches(line: &str) -> Vec<(usize, usize)> {
    let bytes = line.as_bytes();
    let run_at = |from: usize| bytes[from..].iter().take_while(|b| **b == b'`').count();
    let mut found = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] != b'`' {
            at += 1;
            continue;
        }
        let run = run_at(at);
        let body_start = at + run;
        let closing = bytes[body_start..]
            .iter()
            .position(|b| *b == b'`')
            .map(|offset| body_start + offset)
            .filter(|close| run_at(*close) >= run);
        if let Some(close) = closing {
            found.push((at, close + run));
            at = close + run;
        } else if run >= 2 {
            let half = run / 2;
            found.push((at, at + 2 * half));
            at += 2 * half;
        } else {
            at += 1;
        }
    }
    found
}

fn mask_line(line: &str, spans: &mut Vec<MaskedColorSpan>) -> String {
    let mut out = String::with_capacity(line.len());
    let mut last = 0;
    for (start, end) in inline_code_matches(line) {
        out.push_str(&mask_segment(&line[last..start], spans));
        out.push_str(&line[start..end]);
        last = end;
    }
    out.push_str(&mask_segment(&line[last..], spans));
    out
}

/// The fence character of a line that opens or closes one: 3+ of `` ` `` or `~`
/// after leading whitespace.
fn fence_char(line: &str) -> Option<char> {
    let trimmed = js_trim_start(line);
    let ch = trimmed.chars().next().filter(|c| matches!(c, '`' | '~'))?;
    (trimmed.chars().take_while(|c| *c == ch).count() >= 3).then_some(ch)
}

/// Masks color and underline span tags into tokens, skipping fenced code and
/// inline code. A document with no color-span opens keeps its original text.
pub fn mask_inline_color_spans(markdown: &str) -> MaskedColorText {
    if !markdown.contains(SPAN_CLOSE) {
        return MaskedColorText {
            text: markdown.to_owned(),
            spans: Vec::new(),
        };
    }
    let mut spans = Vec::new();
    let mut fence: Option<char> = None;
    let lines: Vec<String> = markdown
        .split('\n')
        .map(|line| {
            if let Some(ch) = fence_char(line) {
                match fence {
                    None => fence = Some(ch),
                    Some(open) if open == ch => fence = None,
                    Some(_) => {}
                }
                return line.to_owned();
            }
            if fence.is_some() {
                line.to_owned()
            } else {
                mask_line(line, &mut spans)
            }
        })
        .collect();
    if spans.is_empty() {
        return MaskedColorText {
            text: markdown.to_owned(),
            spans,
        };
    }
    MaskedColorText {
        text: lines.join("\n"),
        spans,
    }
}

/// Drops `<span style="…">` and `</span>` tags and keeps the text inside them
/// (plain-text previews read the vault markdown directly).
pub fn strip_inline_style_span_tags(markdown: &str) -> String {
    let opens = span_open_matches(markdown);
    let mut tags: Vec<(usize, usize)> = opens.iter().map(|(s, e, _)| (*s, *e)).collect();
    tags.extend(
        markdown
            .match_indices(SPAN_CLOSE)
            .map(|(at, tag)| (at, at + tag.len())),
    );
    tags.sort_unstable();
    let mut out = String::with_capacity(markdown.len());
    let mut last = 0;
    for (start, end) in tags {
        if start < last {
            continue;
        }
        out.push_str(&markdown[last..start]);
        last = end;
    }
    out.push_str(&markdown[last..]);
    out
}

#[derive(Debug)]
enum Token<'t> {
    Open(&'t str),
    Close,
}

/// The `/MEMRYICO(\d+):|:MEMRYICC;/g` matches: `(start, end, token)`.
fn token_matches(text: &str) -> Vec<(usize, usize, Token<'_>)> {
    let mut found = Vec::new();
    let mut at = 0;
    while at < text.len() {
        let rest = &text[at..];
        if let Some(after) = rest.strip_prefix("MEMRYICO") {
            let digits = after.bytes().take_while(u8::is_ascii_digit).count();
            if digits > 0 && after[digits..].starts_with(':') {
                let end = at + "MEMRYICO".len() + digits + 1;
                found.push((at, end, Token::Open(&after[..digits])));
                at = end;
                continue;
            }
        } else if rest.starts_with(CLOSE_TOKEN) {
            let end = at + CLOSE_TOKEN.len();
            found.push((at, end, Token::Close));
            at = end;
            continue;
        }
        at += rest.chars().next().map_or(1, char::len_utf8);
    }
    found
}

fn span_at<'s>(spans: &'s [MaskedColorSpan], digits: &str) -> Option<&'s MaskedColorSpan> {
    digits
        .parse::<usize>()
        .ok()
        .and_then(|index| spans.get(index))
}

/// `mergeActive`: the item's styles with every active span's styles assigned
/// over them; `None` is `undefined`.
fn merge_active(styles: Option<&Json>, active: &[Map<String, Json>]) -> Option<Json> {
    if active.is_empty() {
        return styles.cloned();
    }
    let mut merged = spread_all(&[styles.unwrap_or(&Json::Null)]);
    for layer in active {
        for (key, value) in layer {
            merged.insert(key.clone(), value.clone());
        }
    }
    order_keys(&mut merged);
    Some(Json::Object(merged))
}

/// `{...item, text, styles}`; an `undefined` styles drops the key.
fn run_with(item: &Json, text: &str, styles: Option<Json>) -> Json {
    let mut next = item.clone();
    if let Some(map) = next.as_object_mut() {
        map.insert("text".to_owned(), json!(text));
        match styles {
            Some(styles) => {
                map.insert("styles".to_owned(), styles);
            }
            None => {
                map.shift_remove("styles");
            }
        }
    }
    next
}

fn restore_tokens_in_text(text: &str, spans: &[MaskedColorSpan]) -> String {
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    for (start, end, token) in token_matches(text) {
        out.push_str(&text[last..start]);
        match token {
            Token::Close => out.push_str(SPAN_CLOSE),
            Token::Open(digits) => match span_at(spans, digits) {
                Some(span) => out.push_str(&span.source),
                None => out.push_str(&text[start..end]),
            },
        }
        last = end;
    }
    out.push_str(&text[last..]);
    out
}

fn apply_inline(
    items: &[Json],
    spans: &[MaskedColorSpan],
    active: &mut Vec<Map<String, Json>>,
) -> Vec<Json> {
    let mut out = Vec::new();
    for item in items {
        if let Some(nested) = prop(item, "content").and_then(Json::as_array) {
            let content = apply_inline(nested, spans, active);
            let mut next = item.clone();
            if let Some(map) = next.as_object_mut() {
                map.insert("content".to_owned(), Json::Array(content));
            }
            out.push(next);
            continue;
        }
        let Some(text) = prop(item, "text").and_then(Json::as_str) else {
            out.push(item.clone());
            continue;
        };
        let styles = prop(item, "styles");
        let mut last = 0;
        for (start, end, token) in token_matches(text) {
            let plain = &text[last..start];
            if !plain.is_empty() {
                out.push(run_with(item, plain, merge_active(styles, active)));
            }
            last = end;
            match token {
                Token::Open(digits) => match span_at(spans, digits) {
                    Some(span) => active.push(span.styles.clone()),
                    None => out.push(run_with(
                        item,
                        &text[start..end],
                        merge_active(styles, active),
                    )),
                },
                Token::Close => {
                    active.pop();
                }
            }
        }
        let tail = &text[last..];
        if !tail.is_empty() {
            out.push(run_with(item, tail, merge_active(styles, active)));
        }
    }
    out
}

fn apply_table(content: &Json, spans: &[MaskedColorSpan]) -> Json {
    let Some(rows) = prop(content, "rows").and_then(Json::as_array) else {
        return content.clone();
    };
    let rows: Vec<Json> = rows
        .iter()
        .map(|row| {
            let Some(cells) = prop(row, "cells").and_then(Json::as_array) else {
                return row.clone();
            };
            let cells: Vec<Json> = cells
                .iter()
                .map(|cell| match cell_inline_content(cell) {
                    Some(inline) => {
                        with_cell_content(cell, apply_inline(inline, spans, &mut Vec::new()))
                    }
                    None => cell.clone(),
                })
                .collect();
            let mut next = row.clone();
            if let Some(map) = next.as_object_mut() {
                map.insert("cells".to_owned(), Json::Array(cells));
            }
            next
        })
        .collect();
    let mut next = content.clone();
    if let Some(map) = next.as_object_mut() {
        map.insert("rows".to_owned(), Json::Array(rows));
    }
    next
}

fn apply_blocks(input: &[Json], spans: &[MaskedColorSpan]) -> Vec<Json> {
    input
        .iter()
        .map(|block| {
            let mut next = block.clone();
            let content = prop(block, "content");
            let applied = if prop(block, "type").and_then(Json::as_str) == Some("codeBlock") {
                // Tokens that slipped into code (indented code the fence scan
                // cannot see) are restored verbatim.
                content.and_then(Json::as_array).map(|items| {
                    Json::Array(
                        items
                            .iter()
                            .map(|item| match prop(item, "text").and_then(Json::as_str) {
                                Some(text) => {
                                    let mut run = item.clone();
                                    if let Some(map) = run.as_object_mut() {
                                        map.insert(
                                            "text".to_owned(),
                                            json!(restore_tokens_in_text(text, spans)),
                                        );
                                    }
                                    run
                                }
                                None => item.clone(),
                            })
                            .collect(),
                    )
                })
            } else {
                match content {
                    Some(Json::Array(items)) => {
                        Some(Json::Array(apply_inline(items, spans, &mut Vec::new())))
                    }
                    Some(table) if is_table_content(table) => Some(apply_table(table, spans)),
                    _ => None,
                }
            };
            if let (Some(applied), Some(map)) = (applied, next.as_object_mut()) {
                map.insert("content".to_owned(), applied);
            }
            if let Some(children) = prop(block, "children").and_then(Json::as_array)
                && !children.is_empty()
                && let Some(map) = next.as_object_mut()
            {
                map.insert(
                    "children".to_owned(),
                    Json::Array(apply_blocks(children, spans)),
                );
            }
            next
        })
        .collect()
}

/// Turns the tokens [`mask_inline_color_spans`] left in parsed blocks back into
/// styles on the runs between them.
pub fn apply_inline_color_tokens(blocks: &[Json], spans: &[MaskedColorSpan]) -> Vec<Json> {
    if spans.is_empty() {
        return blocks.to_vec();
    }
    apply_blocks(blocks, spans)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_span_masks_and_unmasks() {
        let masked = mask_inline_color_spans(r#"a <span style="color:red">b</span> c"#);
        assert_eq!(masked.text, "a MEMRYICO0:b:MEMRYICC; c");
        let blocks = vec![json!({"type": "paragraph", "content": [
            {"type": "text", "text": masked.text, "styles": {}}
        ]})];
        let applied = apply_inline_color_tokens(&blocks, &masked.spans);
        assert_eq!(
            applied[0]["content"][1],
            json!({"type": "text", "text": "b", "styles": {"textColor": "red"}})
        );
    }

    #[test]
    fn inline_code_keeps_its_spans() {
        let masked = mask_inline_color_spans("`<span style=\"color:red\">` x</span>");
        assert!(masked.spans.is_empty());
    }
}
