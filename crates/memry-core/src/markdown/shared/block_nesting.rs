//! Port of `packages/shared/src/block-nesting.ts`: the `memry:block-nesting-level`
//! markers that carry a list item's depth across parsers that claim blocks apart.
//!
//! TypeScript tells a marker block apart by identity (a `WeakMap`). Here a marker
//! is a block holding the single key [`MARKER_KEY`] with its level, which no real
//! block has, so a marker survives any pass that moves blocks around.

use std::sync::LazyLock;

use regex::Regex;
use serde::Serialize;
use serde_json::{Map, Number, Value};

use crate::markdown::frontmatter::js::{js_trim, number_to_string};
use crate::markdown::shared::empty_lines::JS_WS;

/// The key of a nesting marker block.
pub const MARKER_KEY: &str = "$memryBlockNestingLevel";

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MarkdownBlockNestingChunk {
    pub level: f64,
    pub text: String,
}

static MARKER_LINE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"^<!--[{JS_WS}]*memry:block-nesting-level=([0-9]+)[{JS_WS}]*-->$"
    ))
    .expect("static pattern")
});

/// `normalizeNestingLevel`: a positive integer, else 0.
fn normalize_nesting_level(level: f64) -> f64 {
    if level.is_finite() && level.fract() == 0.0 && level > 0.0 {
        level
    } else {
        0.0
    }
}

pub fn create_block_nesting_marker(level: f64) -> String {
    format!(
        "<!-- memry:block-nesting-level={} -->",
        number_to_string(normalize_nesting_level(level))
    )
}

/// `Number(digits)` normalised.
fn level_of(digits: &str) -> f64 {
    normalize_nesting_level(digits.parse::<f64>().unwrap_or(0.0))
}

fn trim_edge_newlines(text: &str) -> &str {
    text.trim_matches('\n')
}

pub fn split_markdown_by_block_nesting_markers(markdown: &str) -> Vec<MarkdownBlockNestingChunk> {
    let mut chunks: Vec<MarkdownBlockNestingChunk> = Vec::new();
    let mut current_level = 0.0;
    let mut buffer: Vec<&str> = Vec::new();
    let mut in_code_fence = false;
    let mut open_fence = "";

    fn flush(buffer: &mut Vec<&str>, chunks: &mut Vec<MarkdownBlockNestingChunk>, level: f64) {
        let joined = buffer.join("\n");
        let text = trim_edge_newlines(&joined);
        if !js_trim(text).is_empty() {
            chunks.push(MarkdownBlockNestingChunk {
                level,
                text: text.to_owned(),
            });
        }
        buffer.clear();
    }

    for line in markdown.split('\n') {
        let spaces = line.bytes().take_while(|b| *b == b' ').count().min(3);
        let after = &line[spaces..];
        let fence = if after.starts_with("```") {
            Some("```")
        } else if after.starts_with("~~~") {
            Some("~~~")
        } else {
            None
        };
        if let Some(fence) = fence {
            buffer.push(line);
            if !in_code_fence {
                in_code_fence = true;
                open_fence = fence;
            } else if fence == open_fence {
                in_code_fence = false;
                open_fence = "";
            }
            continue;
        }

        let marker = if in_code_fence {
            None
        } else {
            MARKER_LINE.captures(line)
        };
        if let Some(marker) = marker {
            flush(&mut buffer, &mut chunks, current_level);
            current_level = level_of(&marker[1]);
            continue;
        }
        buffer.push(line);
    }

    flush(&mut buffer, &mut chunks, current_level);
    // A marker with no text after it still moves the level for whatever the
    // caller parses next, so it comes back as an empty chunk.
    if current_level != chunks.last().map_or(0.0, |c| c.level) {
        chunks.push(MarkdownBlockNestingChunk {
            level: current_level,
            text: String::new(),
        });
    }
    chunks
}

/// A level marker block.
pub fn nesting_marker_block(level: f64) -> Value {
    let mut map = Map::new();
    map.insert(
        MARKER_KEY.to_owned(),
        Number::from_f64(level).map_or(Value::from(0), Value::Number),
    );
    Value::Object(map)
}

pub fn is_block_nesting_marker(block: &Value) -> bool {
    block
        .as_object()
        .is_some_and(|map| map.contains_key(MARKER_KEY))
}

/// `markdown` parsed chunk by chunk, with a level marker block before each
/// chunk. Pass the result through [`fold_block_nesting_markers`] before use.
pub fn parse_markdown_with_nesting_markers(
    markdown: &str,
    parse: &mut dyn FnMut(&str) -> Vec<Value>,
) -> Vec<Value> {
    let mut blocks = Vec::new();
    for chunk in split_markdown_by_block_nesting_markers(markdown) {
        blocks.push(nesting_marker_block(chunk.level));
        if !chunk.text.is_empty() {
            blocks.extend(parse(&chunk.text));
        }
    }
    blocks
}

/// The blocks with every level marker removed and its level applied.
pub fn fold_block_nesting_markers(blocks: &[Value]) -> Vec<Value> {
    if !blocks.iter().any(is_block_nesting_marker) {
        return blocks.to_vec();
    }
    let mut content = Vec::new();
    let mut levels = Vec::new();
    let mut level = 0.0;
    for block in blocks {
        match block.as_object().and_then(|map| map.get(MARKER_KEY)) {
            Some(marker_level) => level = marker_level.as_f64().unwrap_or(0.0),
            None => {
                content.push(block.clone());
                levels.push(level);
            }
        }
    }
    if levels.iter().any(|l| *l > 0.0) {
        restore_block_nesting(&content, &levels)
    } else {
        content
    }
}

/// `restoreBlockNesting`: each block becomes a child of the latest block one
/// level up, or a root when there is none.
pub fn restore_block_nesting(blocks: &[Value], levels: &[f64]) -> Vec<Value> {
    let mut roots: Vec<Value> = Vec::new();
    // Path of root index then child indices to the latest block at each level.
    let mut stack: Vec<Vec<usize>> = Vec::new();

    for (index, block) in blocks.iter().enumerate() {
        let level = normalize_nesting_level(levels.get(index).copied().unwrap_or(0.0));
        let mut next = match block {
            Value::Object(map) => map.clone(),
            _ => Map::new(),
        };
        let children = match next.get("children") {
            Some(Value::Array(items)) => Value::Array(items.clone()),
            _ => Value::Array(Vec::new()),
        };
        next.insert("children".to_owned(), children);
        let next = Value::Object(next);

        // `stack[level - 1]`: a level past the stack saturates to no parent.
        let parent_path = (level >= 1.0)
            .then(|| stack.get(level as usize - 1).cloned())
            .flatten();
        let Some(parent_path) = parent_path else {
            roots.push(next);
            stack.clear();
            stack.push(vec![roots.len() - 1]);
            continue;
        };

        let mut parent = &mut roots[parent_path[0]];
        for step in &parent_path[1..] {
            parent = &mut parent["children"][*step];
        }
        let siblings = parent["children"]
            .as_array_mut()
            .expect("children is an array");
        siblings.push(next);
        let mut path = parent_path.clone();
        path.push(siblings.len() - 1);
        stack.truncate(parent_path.len());
        stack.push(path);
    }
    roots
}
