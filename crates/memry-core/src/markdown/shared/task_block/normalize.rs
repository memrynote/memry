//! `normalizeTaskBlocks` of `task-block.ts`: `checkListItem` blocks whose line
//! carries a `{task:<id>}` suffix become `taskBlock` blocks, with the title,
//! id and nesting recovered from the markdown source they were parsed from.

use std::collections::HashMap;
use std::sync::OnceLock;

use regex::Regex;
use serde_json::{Map, Value as Json};

use super::tree::renest_task_tree;
use super::{
    cap_task_tree_depth, checkbox_text_start, children_of, extract_inline_text,
    parse_task_block_suffix, task_id_of,
};
use crate::markdown::shared::block_colors::js_value::{js_trim_start, prop};
use crate::markdown::shared::markdown_fences::FenceTracker;

/// Each task line's title as written in the source, by task id, in the order
/// the ids first appear.
#[derive(Default)]
struct SourceTitles {
    index: HashMap<String, usize>,
    entries: Vec<(String, Vec<String>)>,
}

impl SourceTitles {
    fn push(&mut self, task_id: String, title: String) {
        match self.index.get(&task_id) {
            Some(&at) => self.entries[at].1.push(title),
            None => {
                self.index.insert(task_id.clone(), self.entries.len());
                self.entries.push((task_id, vec![title]));
            }
        }
    }

    fn queue_mut(&mut self, task_id: &str) -> Option<&mut Vec<String>> {
        let at = *self.index.get(task_id)?;
        Some(&mut self.entries[at].1)
    }

    /// `sourceTaskId`: the id a task line holds in the source, given the id
    /// read back from parsed inline text. The parser only ever removes `_` and
    /// `*`, so the source id that matches once those are ignored is the real one.
    fn source_task_id(&self, parsed_id: &str) -> Option<&str> {
        let wanted = bare(parsed_id);
        self.entries
            .iter()
            .map(|(id, _)| id.as_str())
            .find(|id| bare(id) == wanted)
    }
}

fn bare(id: &str) -> String {
    id.replace(['_', '*'], "")
}

fn scan_task_line_titles(markdown: &str) -> SourceTitles {
    let mut titles = SourceTitles::default();
    let mut fence = FenceTracker::new();
    for line in markdown.split('\n') {
        if fence.consume(line) {
            continue;
        }
        let Some((_, start)) = checkbox_text_start(line) else {
            continue;
        };
        if let Some(parsed) = parse_task_block_suffix(&line[start..]) {
            titles.push(parsed.task_id, parsed.title);
        }
    }
    titles
}

/// Each task line's nesting depth among the task lines above it, by indent.
/// The first line for an id wins.
fn scan_task_line_depths(markdown: &str) -> HashMap<String, usize> {
    let mut depths: HashMap<String, usize> = HashMap::new();
    let mut fence = FenceTracker::new();
    let mut open: Vec<usize> = Vec::new();
    for line in markdown.split('\n') {
        if fence.consume(line) || crate::markdown::frontmatter::js::js_trim(line).is_empty() {
            continue;
        }
        let indent = line.chars().count() - js_trim_start(line).chars().count();
        while open.last().is_some_and(|last| *last >= indent) {
            open.pop();
        }
        let parsed = checkbox_text_start(line)
            .and_then(|(_, start)| parse_task_block_suffix(&line[start..]));
        let Some(parsed) = parsed else {
            if indent == 0 {
                open.clear();
            }
            continue;
        };
        depths.entry(parsed.task_id).or_insert(open.len());
        open.push(indent);
    }
    depths
}

/// `/[\p{L}\p{N}]+/gu`.
fn words(text: &str) -> Vec<&str> {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[\p{L}\p{N}]+").expect("a constant pattern"))
        .find_iter(text)
        .map(|found| found.as_str())
        .collect()
}

/// Takes the first queued source title that can be this block's line: its own
/// plain-text words must appear in it, in order.
fn take_source_title(queue: Option<&mut Vec<String>>, plain_title: &str) -> Option<String> {
    let queue = queue?;
    let wanted = words(plain_title);
    let at = queue.iter().position(|candidate| {
        let mut next = 0;
        for word in words(candidate) {
            if wanted.get(next) == Some(&word) {
                next += 1;
            }
        }
        next == wanted.len()
    })?;
    Some(queue.remove(at))
}

struct Normalizer {
    titles: Option<SourceTitles>,
    depths: Option<HashMap<String, usize>>,
    did_change: bool,
}

impl Normalizer {
    fn process(&mut self, list: &[Json], parent_task_id: &str) -> Vec<Json> {
        list.iter()
            .map(|block| self.process_block(block, parent_task_id))
            .collect()
    }

    fn with_children(block: &Json, children: Vec<Json>) -> Json {
        let mut next = block.clone();
        if let Some(map) = next.as_object_mut() {
            map.insert("children".to_owned(), Json::Array(children));
        }
        next
    }

    fn process_block(&mut self, block: &Json, parent_task_id: &str) -> Json {
        let is_task = super::is_task_block(block);
        let children = children_of(block);
        if is_task && !children.is_empty() {
            let processed = self.process(children, &task_id_of(block));
            self.did_change = true;
            return Self::with_children(block, processed);
        }
        if prop(block, "type").and_then(Json::as_str) != Some("checkListItem") {
            if children.is_empty() {
                return block.clone();
            }
            return Self::with_children(block, self.process(children, parent_task_id));
        }

        let text = extract_inline_text(prop(block, "content").unwrap_or(&Json::Null));
        let Some(parsed) = parse_task_block_suffix(&text) else {
            return block.clone();
        };
        self.did_change = true;

        let task_id = match &self.titles {
            Some(titles) if !titles.index.contains_key(&parsed.task_id) => titles
                .source_task_id(&parsed.task_id)
                .map_or(parsed.task_id.clone(), str::to_owned),
            _ => parsed.task_id.clone(),
        };
        let from_source = self
            .titles
            .as_mut()
            .and_then(|titles| take_source_title(titles.queue_mut(&task_id), &parsed.title));
        let title = from_source.unwrap_or(parsed.title);
        let processed = if children.is_empty() {
            Vec::new()
        } else {
            self.process(children, &task_id)
        };

        // `checked` of BlockNote's checkListItem; older callers pass `isChecked`.
        let props = prop(block, "props");
        let checked = props
            .and_then(|p| prop(p, "checked").filter(|v| !v.is_null()))
            .or_else(|| props.and_then(|p| prop(p, "isChecked").filter(|v| !v.is_null())))
            .cloned()
            .unwrap_or(Json::Bool(false));
        let mut task_props = Map::new();
        task_props.insert("taskId".to_owned(), Json::String(task_id));
        task_props.insert("title".to_owned(), Json::String(title));
        task_props.insert("checked".to_owned(), checked);
        task_props.insert(
            "parentTaskId".to_owned(),
            Json::String(parent_task_id.to_owned()),
        );
        let mut task = Map::new();
        task.insert("type".to_owned(), Json::String("taskBlock".to_owned()));
        task.insert("props".to_owned(), Json::Object(task_props));
        task.insert("children".to_owned(), Json::Array(processed));
        if let Some(id) = prop(block, "id") {
            task.insert("id".to_owned(), id.clone());
        }
        let task = Json::Object(task);
        if !parent_task_id.is_empty() {
            return task;
        }
        match &self.depths {
            Some(depths) => cap_task_tree_depth(&renest_task_tree(&task, depths)),
            None => cap_task_tree_depth(&task),
        }
    }
}

/// Whether any string or key of `value` holds `{task:` (`JSON.stringify(value).includes`).
fn mentions_task_suffix(value: &Json) -> bool {
    match value {
        Json::String(text) => text.contains("{task:"),
        Json::Array(items) => items.iter().any(mentions_task_suffix),
        Json::Object(map) => map
            .iter()
            .any(|(key, item)| key.contains("{task:") || mentions_task_suffix(item)),
        _ => false,
    }
}

/// `source` is the markdown `blocks` were parsed from, or `None` for blocks
/// that did not come from markdown (a title then keeps only its plain text).
/// Returns the blocks and whether any changed.
pub fn normalize_task_blocks(blocks: &[Json], source: Option<&str>) -> (Vec<Json>, bool) {
    if !blocks.iter().any(mentions_task_suffix) {
        return (blocks.to_vec(), false);
    }
    let mut normalizer = Normalizer {
        titles: source.map(scan_task_line_titles),
        depths: source.map(scan_task_line_depths),
        did_change: false,
    };
    let next = normalizer.process(blocks, "");
    if normalizer.did_change {
        (next, true)
    } else {
        (blocks.to_vec(), false)
    }
}
