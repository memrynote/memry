//! Port of `packages/shared/src/inline-colors.ts`: inline styles markdown
//! cannot express (text color, background color, underline) persisted as
//! Obsidian-compatible `<span style="…">` HTML.
//!
//! Serialize: colored runs are wrapped in markdown-inert alphanumeric tokens
//! ([`extract_inline_color_runs`]), serialized normally, then the tokens are
//! replaced with span tags ([`restore_inline_color_tokens`]). Parse: span tags
//! are masked into tokens before the markdown parse
//! ([`mask_inline_color_spans`]), then the tokens are found in the parsed
//! inline runs and replaced by styles ([`apply_inline_color_tokens`]).

mod parse;
mod serialize;

use serde_json::{Map, Value as Json};

pub use parse::{
    MaskedColorSpan, MaskedColorText, apply_inline_color_tokens, mask_inline_color_spans,
    strip_inline_style_span_tags,
};
pub use serialize::{extract_inline_color_runs, restore_inline_color_tokens};

use super::block_colors::js_value::{is_object, prop};

pub(crate) const CLOSE_TOKEN: &str = ":MEMRYICC;";

pub(crate) fn open_token(index: usize) -> String {
    format!("MEMRYICO{index}:")
}

/// A table cell's inline content: a bare array (legacy shape) or the `content`
/// of a `{ type: 'tableCell' }` object (BlockNote 0.47+).
pub(crate) fn cell_inline_content(cell: &Json) -> Option<&Vec<Json>> {
    if let Json::Array(items) = cell {
        return Some(items);
    }
    if !is_object(cell) {
        return None;
    }
    prop(cell, "content")?.as_array()
}

/// `cell` with its inline content replaced, in whichever shape it has.
pub(crate) fn with_cell_content(cell: &Json, content: Vec<Json>) -> Json {
    match cell {
        Json::Array(_) => Json::Array(content),
        other => {
            let mut map: Map<String, Json> = other.as_object().cloned().unwrap_or_default();
            map.insert("content".to_owned(), Json::Array(content));
            Json::Object(map)
        }
    }
}

pub(crate) fn is_table_content(content: &Json) -> bool {
    prop(content, "type").and_then(Json::as_str) == Some("tableContent")
}

/// `isSafeColorValue`: a palette value cannot break out of the style attribute.
pub(crate) fn is_safe_color_value(value: &str) -> bool {
    !value.is_empty() && !value.contains([';', '"', '\'', '<', '>'])
}
