//! `inline/html-comment.ts`: `writeHtmlCommentTokens`. Every `htmlComment`
//! node is written as its token while a markdown serialization runs (the
//! exporter does that for it), inside the marks it sat in, and each run of
//! emphasis becomes one span.

use serde_json::{Map, Value as Json};

use super::emphasis_runs::{
    Span, list_link_break_tokens, restore_emphasis_runs, tokenize_emphasis_runs,
};
use crate::markdown::convert::ConvertError;
use crate::markdown::shared::block_copy::clone_without;
use crate::markdown::shared::html_comments::encode_html_comment_token;

fn type_of(item: &Json) -> &str {
    item.get("type").and_then(Json::as_str).unwrap_or("")
}

fn text_neighbour(items: &[Json], index: usize, step: isize) -> Option<&Json> {
    let mut at = index as isize + step;
    while at >= 0
        && items
            .get(at as usize)
            .is_some_and(|i| type_of(i) == "htmlComment")
    {
        at += step;
    }
    items
        .get(usize::try_from(at).ok()?)
        .filter(|i| type_of(i) == "text")
}

/// `[^\S\n]`.
fn is_blank(c: char) -> bool {
    c != '\n' && crate::markdown::frontmatter::js::is_js_whitespace(c)
}

/// The marks a comment sat inside (BBF-52): the ones a neighbour holds on a
/// whitespace edge next to the comment. Never `code`.
fn enclosing_marks(left: Option<&Json>, right: Option<&Json>) -> Map<String, Json> {
    let mut marks = Map::new();
    let sides = [
        (
            left,
            left.and_then(text)
                .is_some_and(|t| t.chars().next_back().is_some_and(is_blank)),
        ),
        (
            right,
            right
                .and_then(text)
                .is_some_and(|t| t.chars().next().is_some_and(is_blank)),
        ),
    ];
    for (side, open) in sides {
        if !open {
            continue;
        }
        if let Some(styles) = side.and_then(|s| s.get("styles")).and_then(Json::as_object) {
            for (name, on) in styles {
                if on == &Json::Bool(true) && name != "code" {
                    marks.insert(name.clone(), Json::Bool(true));
                }
            }
        }
    }
    marks
}

fn text(item: &Json) -> Option<&str> {
    item.get("text").and_then(Json::as_str)
}

fn same_styles(a: &Json, b: &Json) -> bool {
    let empty = Map::new();
    let a = a.get("styles").and_then(Json::as_object).unwrap_or(&empty);
    let b = b.get("styles").and_then(Json::as_object).unwrap_or(&empty);
    a.len() == b.len() && a.iter().all(|(k, v)| b.get(k) == Some(v))
}

/// Each comment inside marks as a text run holding them, joined to the
/// neighbours with the same marks.
fn comments_in_marks(items: &[Json]) -> Vec<Json> {
    let mut out: Vec<Json> = Vec::new();
    for (index, item) in items.iter().enumerate() {
        let mut next = item.clone();
        if let Some(content) = item.get("content").and_then(Json::as_array) {
            next["content"] = Json::Array(comments_in_marks(content));
        } else if type_of(item) == "htmlComment" {
            let marks = enclosing_marks(
                text_neighbour(items, index, -1),
                text_neighbour(items, index, 1),
            );
            if !marks.is_empty() {
                let source = item
                    .get("props")
                    .and_then(|p| p.get("source"))
                    .map_or_else(String::new, |s| {
                        s.as_str().map_or_else(|| s.to_string(), str::to_owned)
                    });
                next = serde_json::json!({
                    "type": "text",
                    "text": encode_html_comment_token(&source),
                    "styles": Json::Object(marks),
                });
            }
        }
        if let Some(last) = out.last_mut()
            && type_of(last) == "text"
            && type_of(&next) == "text"
            && same_styles(last, &next)
        {
            let joined = format!("{}{}", text(last).unwrap_or(""), text(&next).unwrap_or(""));
            last["text"] = Json::String(joined);
        } else {
            out.push(next);
        }
    }
    out
}

fn inline(
    items: &[Json],
    block_type: Option<&str>,
    marks: &mut Vec<Span>,
) -> Result<Vec<Json>, ConvertError> {
    let items = if matches!(
        block_type,
        Some("bulletListItem" | "numberedListItem" | "checkListItem")
    ) {
        list_link_break_tokens(items.to_vec(), marks)
    } else {
        items.to_vec()
    };
    tokenize_emphasis_runs(comments_in_marks(&items), marks)
}

/// A cell is a bare inline array in the legacy shape and `{ content }` in BlockNote 0.47+.
fn map_cell(cell: &Json, marks: &mut Vec<Span>) -> Result<Json, ConvertError> {
    if let Some(items) = cell.as_array() {
        return Ok(Json::Array(inline(items, None, marks)?));
    }
    let Some(content) = cell.get("content").and_then(Json::as_array) else {
        return Ok(cell.clone());
    };
    let mut next = cell.clone();
    next["content"] = Json::Array(inline(content, None, marks)?);
    Ok(next)
}

fn map_inline(blocks: &[Json], marks: &mut Vec<Span>) -> Result<Vec<Json>, ConvertError> {
    blocks
        .iter()
        .map(|block| {
            let mut next = clone_without(block, &["content", "children"]);
            let block_type = block.get("type").and_then(Json::as_str);
            let mut content = None;
            if let Some(items) = block.get("content").and_then(Json::as_array) {
                content = Some(Json::Array(inline(items, block_type, marks)?));
            } else if block
                .get("content")
                .and_then(|c| c.get("type"))
                .and_then(Json::as_str)
                == Some("tableContent")
            {
                let table = &block["content"];
                let rows: Vec<Json> = table
                    .get("rows")
                    .and_then(Json::as_array)
                    .into_iter()
                    .flatten()
                    .map(|row| {
                        let mut row = row.clone();
                        let cells = row
                            .get("cells")
                            .and_then(Json::as_array)
                            .into_iter()
                            .flatten()
                            .map(|c| map_cell(c, marks))
                            .collect::<Result<Vec<Json>, _>>()?;
                        row["cells"] = Json::Array(cells);
                        Ok(row)
                    })
                    .collect::<Result<Vec<Json>, ConvertError>>()?;
                let mut table = table.clone();
                table["rows"] = Json::Array(rows);
                content = Some(table);
            }
            let children = match block.get("children").and_then(Json::as_array) {
                Some(children) => Some(Json::Array(map_inline(children, marks)?)),
                None => None,
            };
            if let Some(map) = next.as_object_mut() {
                for (key, mapped) in [("content", content), ("children", children)] {
                    if let Some(original) = block.get(key) {
                        map.insert(key.to_owned(), mapped.unwrap_or_else(|| original.clone()));
                    }
                }
            }
            Ok(next)
        })
        .collect()
}

/// Serializes `blocks` with every comment written as its token, inside the
/// marks it sat in, and each run of emphasis written as one span.
pub fn write_html_comment_tokens(
    blocks: &[Json],
    serialize: impl FnOnce(&[Json]) -> Result<String, ConvertError>,
) -> Result<String, ConvertError> {
    let mut marks: Vec<Span> = Vec::new();
    let marked = map_inline(blocks, &mut marks)?;
    let out = serialize(&marked)?;
    Ok(restore_emphasis_runs(&out, &marks))
}
