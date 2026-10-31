//! Port of `packages/shared/src/task-block.ts`: a task is a checkbox with a
//! trailing `{task:<id>}` suffix (`- [ ] Buy milk {task:abc}`).
//! `normalize_task_blocks` upgrades such `checkListItem` blocks into the
//! custom `taskBlock` type; `serialize_task_block` writes one back.
//!
//! Blocks are BlockNote JSON (`serde_json::Value`). The Y.Doc-touching half of
//! the TypeScript module does not exist: this file has none.

mod normalize;
mod tree;

use std::collections::HashMap;

use serde_json::Value as Json;

pub use normalize::normalize_task_blocks;
pub use tree::cap_task_tree_depth;

use super::block_colors::js_value::{
    is_object, js_to_string, js_trim_end, js_trim_start, prop, spread_all, truthy,
};
use super::obsidian_tasks::parse_obsidian_task_fields;
use crate::markdown::frontmatter::js::js_trim;

const TASK_BLOCK_SUFFIX_OPEN: &str = "{task:";

/// How many task levels a note body holds under a top-level task. Builds
/// released before nested subtasks parse and write back only one level.
pub const MAX_NOTE_TASK_DEPTH: usize = 1;

/// `props.taskId` of a task block; `""` when a malformed block has none.
pub(crate) fn task_id_of(block: &Json) -> String {
    prop(block, "props")
        .and_then(|props| prop(props, "taskId"))
        .and_then(Json::as_str)
        .unwrap_or("")
        .to_owned()
}

pub(crate) fn is_task_block(block: &Json) -> bool {
    prop(block, "type").and_then(Json::as_str) == Some("taskBlock")
}

/// `block.children ?? []`, for an array.
pub(crate) fn children_of(block: &Json) -> &[Json] {
    prop(block, "children")
        .and_then(Json::as_array)
        .map_or(&[], Vec::as_slice)
}

/// `serializeTaskBlock`: the checkbox line of a task block's props
/// (`taskId`, `title`, `checked`, optional `parentTaskId`).
pub fn serialize_task_block(props: &Json) -> String {
    let check = if prop(props, "checked").is_some_and(truthy) {
        'x'
    } else {
        ' '
    };
    let indent = if prop(props, "parentTaskId").is_some_and(truthy) {
        "  "
    } else {
        ""
    };
    let title = js_to_string(prop(props, "title"));
    // A draft task block has no row yet: an empty `{task:}` names nothing.
    match prop(props, "taskId").filter(|id| truthy(id)) {
        None => format!("{indent}- [{check}] {title}"),
        Some(id) => format!(
            "{indent}- [{check}] {title} {{task:{}}}",
            js_to_string(Some(id))
        ),
    }
}

/// A task block and the task blocks under it, one tight-list line each, capped
/// at [`MAX_NOTE_TASK_DEPTH`]. `None` where the TypeScript throws (a block with
/// no props).
pub fn serialize_task_block_tree(block: &Json) -> Option<Vec<String>> {
    let props = prop(block, "props").filter(|props| !props.is_null())?;
    let mut lines = vec![serialize_task_block(props)];
    let capped = cap_task_tree_depth(block);
    walk_lines(children_of(&capped), 1, &mut lines);
    Some(lines)
}

fn walk_lines(children: &[Json], depth: usize, lines: &mut Vec<String>) {
    for child in children {
        if !is_task_block(child) {
            continue;
        }
        let props = prop(child, "props").cloned().unwrap_or(Json::Null);
        let mut flat = spread_all(&[&props]);
        flat.insert("parentTaskId".to_owned(), Json::String(String::new()));
        lines.push(format!(
            "{}{}",
            "  ".repeat(depth),
            serialize_task_block(&Json::Object(flat))
        ));
        walk_lines(children_of(child), depth + 1, lines);
    }
}

/// Where `{task:` opens and its `}` closes, as byte offsets into right-trimmed text.
struct TaskSuffixSpan {
    open: usize,
    close: usize,
}

fn locate_task_suffix(trimmed: &str) -> Option<TaskSuffixSpan> {
    let open = trimmed.rfind(TASK_BLOCK_SUFFIX_OPEN)?;
    if trimmed.ends_with('}') {
        let close = trimmed.len() - 1;
        if trimmed[open..close].contains('}') {
            return None;
        }
        return Some(TaskSuffixSpan { open, close });
    }
    // The Obsidian Tasks plugin appends its own fields after the suffix; the
    // suffix is still ours when everything behind it is plugin syntax.
    let close = open + trimmed[open..].find('}')?;
    if !parse_obsidian_task_fields(&trimmed[close + 1..])
        .description
        .is_empty()
    {
        return None;
    }
    Some(TaskSuffixSpan { open, close })
}

/// `{ taskId, title }` of a line's suffix.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskSuffix {
    pub task_id: String,
    pub title: String,
}

pub fn parse_task_block_suffix(text: &str) -> Option<TaskSuffix> {
    let trimmed = js_trim_end(text);
    let span = locate_task_suffix(trimmed)?;
    let task_id = &trimmed[span.open + TASK_BLOCK_SUFFIX_OPEN.len()..span.close];
    if task_id.is_empty() {
        return None;
    }
    Some(TaskSuffix {
        task_id: task_id.to_owned(),
        title: js_trim(&trimmed[..span.open]).to_owned(),
    })
}

/// A checkbox line's state and the byte offset its text starts at, or `None`
/// for any other line. Any list marker, any indentation, `x` or `X`.
pub(crate) fn checkbox_text_start(line: &str) -> Option<(bool, usize)> {
    let trimmed = js_trim_start(line);
    let bytes = trimmed.as_bytes();
    if bytes.len() < 5 || !matches!(bytes[0], b'-' | b'*' | b'+') {
        return None;
    }
    if bytes[1] != b' ' || bytes[2] != b'[' || bytes[4] != b']' {
        return None;
    }
    let checked = matches!(bytes[3], b'x' | b'X');
    if !checked && bytes[3] != b' ' {
        return None;
    }
    Some((checked, line.len() - trimmed.len() + 5))
}

/// Each task id's checkbox state in `markdown`, in order of first appearance
/// (a later line for the same id overwrites the state).
pub fn scan_task_checkbox_states(markdown: &str) -> Vec<(String, bool)> {
    let mut states: Vec<(String, bool)> = Vec::new();
    if !markdown.contains(TASK_BLOCK_SUFFIX_OPEN) {
        return states;
    }
    // Each id's place in `states`: a note with tens of thousands of tasks stays linear.
    let mut slots: HashMap<String, usize> = HashMap::new();
    for line in markdown.split('\n') {
        let Some((checked, start)) = checkbox_text_start(line) else {
            continue;
        };
        let Some(parsed) = parse_task_block_suffix(&line[start..]) else {
            continue;
        };
        match slots.get(&parsed.task_id) {
            Some(&slot) => states[slot].1 = checked,
            None => {
                slots.insert(parsed.task_id.clone(), states.len());
                states.push((parsed.task_id, checked));
            }
        }
    }
    states
}

/// Turns every task line back into the plain checkbox it was typed as, the
/// empty `{task:}` of an id-less task block included. Every other byte survives.
pub fn strip_task_block_suffixes(markdown: &str) -> String {
    if !markdown.contains(TASK_BLOCK_SUFFIX_OPEN) {
        return markdown.to_owned();
    }
    markdown
        .split('\n')
        .map(strip_line)
        .collect::<Vec<_>>()
        .join("\n")
}

fn strip_line(line: &str) -> String {
    let Some((_, start)) = checkbox_text_start(line) else {
        return line.to_owned();
    };
    let text = &line[start..];
    let trimmed = js_trim_end(text);
    let Some(span) = locate_task_suffix(trimmed) else {
        return line.to_owned();
    };
    format!(
        "{}{}{}{}",
        &line[..start],
        js_trim_end(&trimmed[..span.open]),
        &trimmed[span.close + 1..],
        &text[trimmed.len()..]
    )
}

/// The text of an inline-content value: a string, or the `text` runs of an array.
pub fn extract_inline_text(content: &Json) -> String {
    match content {
        Json::String(text) => text.clone(),
        Json::Array(items) => items
            .iter()
            .map(|item| match item {
                Json::String(text) => text.as_str(),
                other
                    if is_object(other)
                        && prop(other, "type").and_then(Json::as_str) == Some("text") =>
                {
                    prop(other, "text").and_then(Json::as_str).unwrap_or("")
                }
                _ => "",
            })
            .collect(),
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn suffix_survives_an_obsidian_tasks_tail() {
        let parsed = parse_task_block_suffix("Buy milk {task:abc} 📅 2026-01-01").unwrap();
        assert_eq!(parsed.task_id, "abc");
        assert_eq!(parsed.title, "Buy milk");
        assert!(parse_task_block_suffix("Buy milk {task:abc} and more").is_none());
    }

    #[test]
    fn a_subtask_is_written_indented() {
        let block = json!({"type": "taskBlock", "props": {"taskId": "a", "title": "A", "checked": false},
            "children": [{"type": "taskBlock", "props": {"taskId": "b", "title": "B", "checked": true}}]});
        assert_eq!(
            serialize_task_block_tree(&block).unwrap(),
            vec!["- [ ] A {task:a}", "  - [x] B {task:b}"]
        );
    }
}
