//! Port of `packages/shared/src/obsidian-tasks.ts`: reads a task line written
//! by the Obsidian Tasks plugin, in its emoji and Dataview inline-field
//! formats, and names the three constructs Memry must not rewrite.

mod recurrence;
mod rules;

use serde_json::{Map, Value as Json, json};

pub use recurrence::{Frequency, ObsidianRecurrence};

use crate::domain::tags::fold;
use crate::markdown::frontmatter::js::js_trim;
use rules::{
    DATAVIEW_MARKER, EMOJI_SYMBOLS, block_link, has_tag_anywhere, hash_tags, strip_fields,
    task_line,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ObsidianPriority {
    Highest,
    High,
    Medium,
    Low,
    Lowest,
}

impl ObsidianPriority {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Highest => "highest",
            Self::High => "high",
            Self::Medium => "medium",
            Self::Low => "low",
            Self::Lowest => "lowest",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ObsidianStatusType {
    Todo,
    Done,
    InProgress,
    Cancelled,
    OnHold,
    NonTask,
    Empty,
}

impl ObsidianStatusType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Todo => "TODO",
            Self::Done => "DONE",
            Self::InProgress => "IN_PROGRESS",
            Self::Cancelled => "CANCELLED",
            Self::OnHold => "ON_HOLD",
            Self::NonTask => "NON_TASK",
            Self::Empty => "EMPTY",
        }
    }
}

/// `ObsidianImportBlocker`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ObsidianImportBlocker {
    BlockLink,
    TaskId,
    DependsOn,
}

impl ObsidianImportBlocker {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::BlockLink => "block-link",
            Self::TaskId => "task-id",
            Self::DependsOn => "depends-on",
        }
    }
}

/// `ObsidianTaskFields`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ObsidianTaskFields {
    pub description: String,
    pub tags: Vec<String>,
    pub priority: Option<ObsidianPriority>,
    pub due_date: Option<String>,
    pub scheduled_date: Option<String>,
    pub start_date: Option<String>,
    pub created_date: Option<String>,
    pub done_date: Option<String>,
    pub cancelled_date: Option<String>,
    pub recurrence_text: Option<String>,
    pub recurrence: Option<ObsidianRecurrence>,
    pub on_completion: Option<String>,
    pub id: Option<String>,
    pub depends_on: Vec<String>,
    pub block_link: Option<String>,
}

fn text_or_null(value: &Option<String>) -> Json {
    value.as_ref().map_or(Json::Null, |text| json!(text))
}

impl ObsidianTaskFields {
    fn write_json(&self, map: &mut Map<String, Json>) {
        map.insert("description".into(), json!(self.description));
        map.insert("tags".into(), json!(self.tags));
        map.insert(
            "priority".into(),
            self.priority.map_or(Json::Null, |p| json!(p.as_str())),
        );
        map.insert("dueDate".into(), text_or_null(&self.due_date));
        map.insert("scheduledDate".into(), text_or_null(&self.scheduled_date));
        map.insert("startDate".into(), text_or_null(&self.start_date));
        map.insert("createdDate".into(), text_or_null(&self.created_date));
        map.insert("doneDate".into(), text_or_null(&self.done_date));
        map.insert("cancelledDate".into(), text_or_null(&self.cancelled_date));
        map.insert("recurrenceText".into(), text_or_null(&self.recurrence_text));
        map.insert(
            "recurrence".into(),
            self.recurrence
                .as_ref()
                .map_or(Json::Null, ObsidianRecurrence::to_json),
        );
        map.insert("onCompletion".into(), text_or_null(&self.on_completion));
        map.insert("id".into(), text_or_null(&self.id));
        map.insert("dependsOn".into(), json!(self.depends_on));
        map.insert("blockLink".into(), text_or_null(&self.block_link));
    }

    /// The object the TypeScript returns, keys in its order.
    pub fn to_json(&self) -> Json {
        let mut map = Map::new();
        self.write_json(&mut map);
        Json::Object(map)
    }
}

/// `ObsidianTaskLine`: the fields plus the line's own parts.
#[derive(Debug, Clone, PartialEq)]
pub struct ObsidianTaskLine {
    pub fields: ObsidianTaskFields,
    pub indentation: String,
    pub list_marker: String,
    pub status_char: String,
    pub status_type: ObsidianStatusType,
}

impl ObsidianTaskLine {
    pub fn to_json(&self) -> Json {
        let mut map = Map::new();
        self.fields.write_json(&mut map);
        map.insert("indentation".into(), json!(self.indentation));
        map.insert("listMarker".into(), json!(self.list_marker));
        map.insert("statusChar".into(), json!(self.status_char));
        map.insert("statusType".into(), json!(self.status_type.as_str()));
        Json::Object(map)
    }
}

fn extract_tags(description: &str) -> Vec<String> {
    let mut tags: Vec<String> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for found in hash_tags().find_iter(description) {
        let tag = js_trim(found.as_str());
        let key = fold(tag);
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        tags.push(tag.to_owned());
    }
    tags
}

/// Whether `text` holds anything `parse_obsidian_task_fields` would read.
pub fn has_obsidian_task_fields(text: &str) -> bool {
    text.contains(DATAVIEW_MARKER)
        || EMOJI_SYMBOLS.iter().any(|symbol| text.contains(symbol))
        || block_link().is_match(text)
        || has_tag_anywhere(text)
}

pub fn parse_obsidian_task_fields(text: &str) -> ObsidianTaskFields {
    let mut body = js_trim(text).to_owned();

    // Peeled before the strip loop, as the plugin does: a trailing block link
    // would hide the field in front of it.
    let mut block_link_text = None;
    if let Some(link) = block_link().find(&body) {
        block_link_text = Some(js_trim(link.as_str()).to_owned());
        let range = link.range();
        body = js_trim(&format!("{}{}", &body[..range.start], &body[range.end..])).to_owned();
    }

    let mut out = ObsidianTaskFields::default();
    let description = strip_fields(&body, &mut out);
    out.tags = extract_tags(&description);
    out.description = description;
    out.block_link = block_link_text;
    out
}

fn status_type_for(status_char: &str) -> ObsidianStatusType {
    match status_char {
        "x" | "X" => ObsidianStatusType::Done,
        "/" => ObsidianStatusType::InProgress,
        "-" => ObsidianStatusType::Cancelled,
        "" => ObsidianStatusType::Empty,
        _ => ObsidianStatusType::Todo,
    }
}

pub fn parse_obsidian_task_line(line: &str) -> Option<ObsidianTaskLine> {
    let caps = task_line().captures(line)?;
    let group = |index: usize| caps.get(index).map_or("", |m| m.as_str());
    let status_char = group(3);
    Some(ObsidianTaskLine {
        fields: parse_obsidian_task_fields(group(4)),
        indentation: group(1).to_owned(),
        list_marker: group(2).to_owned(),
        status_char: status_char.to_owned(),
        status_type: status_type_for(status_char),
    })
}

pub fn obsidian_task_import_blocker(text: &str) -> Option<ObsidianImportBlocker> {
    if block_link().is_match(text) {
        return Some(ObsidianImportBlocker::BlockLink);
    }
    let fields = parse_obsidian_task_fields(text);
    if fields.id.is_some() {
        return Some(ObsidianImportBlocker::TaskId);
    }
    if !fields.depends_on.is_empty() {
        return Some(ObsidianImportBlocker::DependsOn);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn emoji_fields_come_off_the_tail() {
        let fields = parse_obsidian_task_fields("Buy milk ⏫ 📅 2026-01-01 #home");
        assert_eq!(fields.description, "Buy milk #home");
        assert_eq!(fields.due_date.as_deref(), Some("2026-01-01"));
        assert_eq!(fields.priority, Some(ObsidianPriority::High));
        assert_eq!(fields.tags, vec!["#home"]);
    }

    #[test]
    fn dataview_fields_need_a_matched_pair() {
        assert_eq!(
            parse_obsidian_task_fields("a [due:: 2026-01-01]")
                .due_date
                .as_deref(),
            Some("2026-01-01")
        );
        assert_eq!(
            parse_obsidian_task_fields("a [due:: 2026-01-01)").due_date,
            None
        );
    }
}
