//! Port of `packages/shared/src/plain-checkbox.ts`: a `- [ ] Passport {check}`
//! line stays a checkbox and is never converted to a task. The trailing
//! `{check}` marker is the `plain` prop of a `checkListItem` block.

use serde_json::{Value as Json, json};

use super::block_colors::js_value::{js_trim_end, prop, spread_all};

pub const PLAIN_CHECKBOX_MARKER: &str = "{check}";

/// The block's inline content without a trailing marker, or `None` when the
/// last run does not end with one. Only the last run is read.
fn strip_marker(content: &Json) -> Option<Vec<Json>> {
    let runs = content.as_array()?;
    let last = runs.last()?;
    if prop(last, "type").and_then(Json::as_str) != Some("text") {
        return None;
    }
    let text = prop(last, "text")?.as_str()?;
    let trimmed = js_trim_end(text);
    let before = js_trim_end(trimmed.strip_suffix(PLAIN_CHECKBOX_MARKER)?);
    let mut next: Vec<Json> = runs[..runs.len() - 1].to_vec();
    if !before.is_empty() {
        let mut run = last.clone();
        if let Some(map) = run.as_object_mut() {
            map.insert("text".to_owned(), json!(before));
        }
        next.push(run);
    }
    Some(next)
}

/// True when a plain checkbox's line text ends with the marker.
pub fn has_plain_checkbox_marker(text: &str) -> bool {
    js_trim_end(text).ends_with(PLAIN_CHECKBOX_MARKER)
}

fn has_children(block: &Json) -> bool {
    prop(block, "children")
        .and_then(Json::as_array)
        .is_some_and(|children| !children.is_empty())
}

fn is_type(block: &Json, name: &str) -> bool {
    prop(block, "type").and_then(Json::as_str) == Some(name)
}

/// Parse side: every `checkListItem` whose line ends with the marker loses it
/// from its text and gains `plain: true`, at every depth. Returns whether
/// anything changed.
pub fn normalize_plain_checkboxes(blocks: &mut [Json]) -> bool {
    let mut did_change = false;
    for block in blocks {
        if is_type(block, "checkListItem")
            && let Some(content) = prop(block, "content").and_then(strip_marker)
        {
            let props = block.get("props").cloned().unwrap_or(Json::Null);
            let mut merged = spread_all(&[&props]);
            merged.insert("plain".to_owned(), Json::Bool(true));
            if let Some(map) = block.as_object_mut() {
                map.insert("content".to_owned(), Json::Array(content));
                map.insert("props".to_owned(), Json::Object(merged));
            }
            did_change = true;
        }
        if has_children(block)
            && let Some(children) = block.get_mut("children").and_then(Json::as_array_mut)
            && normalize_plain_checkboxes(children)
        {
            did_change = true;
        }
    }
    did_change
}

/// Serialize side: every plain `checkListItem` gets the marker as a last,
/// unstyled run, so the line is written `- [ ] Passport {check}`.
pub fn with_plain_checkbox_markers(blocks: &mut [Json]) {
    for block in blocks {
        if is_type(block, "checkListItem")
            && prop(block, "props")
                .and_then(|props| prop(props, "plain"))
                .is_some_and(|plain| plain == &Json::Bool(true))
        {
            let mut content = block
                .get("content")
                .and_then(Json::as_array)
                .cloned()
                .unwrap_or_default();
            let marker = if content.is_empty() {
                PLAIN_CHECKBOX_MARKER.to_owned()
            } else {
                format!(" {PLAIN_CHECKBOX_MARKER}")
            };
            content.push(json!({"type": "text", "text": marker, "styles": {}}));
            if let Some(map) = block.as_object_mut() {
                map.insert("content".to_owned(), Json::Array(content));
            }
        }
        if has_children(block)
            && let Some(children) = block.get_mut("children").and_then(Json::as_array_mut)
        {
            with_plain_checkbox_markers(children);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marker_round_trips_through_the_plain_prop() {
        let mut blocks = vec![json!({
            "type": "checkListItem", "props": {"checked": false},
            "content": [{"type": "text", "text": "Passport {check}", "styles": {}}]
        })];
        assert!(normalize_plain_checkboxes(&mut blocks));
        assert_eq!(blocks[0]["props"], json!({"checked": false, "plain": true}));
        with_plain_checkbox_markers(&mut blocks);
        assert_eq!(blocks[0]["content"][1]["text"], json!(" {check}"));
    }
}
