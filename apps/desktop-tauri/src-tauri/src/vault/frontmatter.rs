//! YAML frontmatter parser, serializer, and property extractor.
//!
//! Parser is gray-matter-compatible enough for Electron-authored
//! `.md` files: `---` fence at the start, YAML 1.1 between fences,
//! body after. Reserved frontmatter keys (id/title/created/modified/
//! tags/aliases/emoji/local_only/properties) are pulled into the
//! typed `NoteFrontmatter` struct; everything else is extracted by
//! `extract_properties()` for the renderer's property-definitions
//! system.
//!
//! Required field auto-fill matches Electron's `parseNote`: missing
//! `id` → fresh nanoid; missing `created`/`modified` → now ISO; the
//! caller checks `was_modified` to know when to re-serialize.

use crate::error::AppResult;
use serde_yaml_ng as yaml;
use serde_yaml_ng::Value;
use std::collections::BTreeMap;
use std::path::Path;

const RESERVED_KEYS: &[&str] = &[
    "id",
    "title",
    "created",
    "modified",
    "tags",
    "aliases",
    "emoji",
    "localOnly",
    "properties",
];

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteFrontmatter {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub created: String,
    pub modified: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub aliases: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub emoji: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_only: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = Option<BTreeMap<String, serde_json::Value>>)]
    pub properties: Option<BTreeMap<String, Value>>,
    /// Catch-all for non-reserved keys (matches Electron's
    /// "top-level keys are properties unless reserved").
    #[serde(flatten)]
    #[specta(type = BTreeMap<String, serde_json::Value>)]
    pub extra: BTreeMap<String, Value>,
}

impl NoteFrontmatter {
    pub fn extract_properties(&self) -> BTreeMap<String, Value> {
        if let Some(p) = &self.properties {
            return p.clone();
        }
        let mut out = BTreeMap::new();
        for (k, v) in &self.extra {
            if !RESERVED_KEYS.contains(&k.as_str()) {
                out.insert(k.clone(), v.clone());
            }
        }
        out
    }
}

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ParsedNote {
    pub frontmatter: NoteFrontmatter,
    pub content: String,
    pub had_frontmatter: bool,
    pub was_modified: bool,
}

/// Parse a markdown file with optional YAML frontmatter. Auto-fills
/// required fields when missing.
pub fn parse_note(raw: &str, file_path: Option<&str>) -> AppResult<ParsedNote> {
    let (yaml_text, body, had_frontmatter) = split_frontmatter(raw);

    let data: BTreeMap<String, Value> = if yaml_text.is_empty() {
        BTreeMap::new()
    } else {
        yaml::from_str(&yaml_text).unwrap_or_default()
    };

    let now = current_iso();
    let mut was_modified = false;

    let id = match data.get("id").and_then(Value::as_str) {
        Some(v) if !v.is_empty() => v.to_string(),
        _ => {
            was_modified = true;
            generate_note_id()
        }
    };

    let created = match data.get("created") {
        Some(Value::String(s)) => s.clone(),
        Some(other) => yaml_value_to_string(other),
        None => {
            was_modified = true;
            now.clone()
        }
    };
    let modified = match data.get("modified") {
        Some(Value::String(s)) => s.clone(),
        Some(other) => yaml_value_to_string(other),
        None => {
            was_modified = true;
            now.clone()
        }
    };

    let title = data
        .get("title")
        .and_then(Value::as_str)
        .map(|s| s.to_string())
        .or_else(|| file_path.map(extract_title_from_path));

    let tags = data
        .get("tags")
        .and_then(|v| v.as_sequence())
        .map(|seq| {
            seq.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    let aliases = data
        .get("aliases")
        .and_then(|v| v.as_sequence())
        .map(|seq| {
            seq.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    let emoji = data.get("emoji").and_then(Value::as_str).map(String::from);
    let local_only = data.get("localOnly").and_then(Value::as_bool);
    let properties = data
        .get("properties")
        .and_then(|v| v.as_mapping())
        .map(|map| {
            let mut out = BTreeMap::new();
            for (k, v) in map.iter() {
                if let Some(key) = k.as_str() {
                    out.insert(key.to_string(), v.clone());
                }
            }
            out
        });

    let mut extra = BTreeMap::new();
    for (k, v) in data.into_iter() {
        if !RESERVED_KEYS.contains(&k.as_str()) {
            extra.insert(k, v);
        }
    }

    let frontmatter = NoteFrontmatter {
        id,
        title,
        created,
        modified,
        tags,
        aliases,
        emoji,
        local_only,
        properties,
        extra,
    };

    Ok(ParsedNote {
        frontmatter,
        content: body.trim().to_string(),
        had_frontmatter,
        was_modified,
    })
}

/// Serialize frontmatter + body back to a markdown file. Bumps
/// `modified` to now.
pub fn serialize_note(fm: &NoteFrontmatter, content: &str) -> AppResult<String> {
    let out = NoteFrontmatter {
        modified: current_iso(),
        ..fm.clone()
    };

    let mut map = BTreeMap::<String, Value>::new();
    map.insert("id".into(), Value::String(out.id.clone()));
    if let Some(title) = &out.title {
        map.insert("title".into(), Value::String(title.clone()));
    }
    map.insert("created".into(), Value::String(out.created.clone()));
    map.insert("modified".into(), Value::String(out.modified.clone()));
    if !out.tags.is_empty() {
        map.insert(
            "tags".into(),
            Value::Sequence(out.tags.iter().map(|t| Value::String(t.clone())).collect()),
        );
    }
    if !out.aliases.is_empty() {
        map.insert(
            "aliases".into(),
            Value::Sequence(
                out.aliases
                    .iter()
                    .map(|t| Value::String(t.clone()))
                    .collect(),
            ),
        );
    }
    if let Some(emoji) = &out.emoji {
        map.insert("emoji".into(), Value::String(emoji.clone()));
    }
    if let Some(b) = out.local_only {
        map.insert("localOnly".into(), Value::Bool(b));
    }
    if let Some(props) = &out.properties {
        let mapping: yaml::Mapping = props
            .iter()
            .map(|(k, v)| (Value::String(k.clone()), v.clone()))
            .collect();
        map.insert("properties".into(), Value::Mapping(mapping));
    }
    for (k, v) in &out.extra {
        if !map.contains_key(k) {
            map.insert(k.clone(), v.clone());
        }
    }

    let yaml_text = yaml::to_string(&map)?;
    let body = content.trim_end_matches(['\n']).to_string();
    Ok(format!("---\n{yaml_text}---\n{body}"))
}

/// Convenience: build a fresh frontmatter for a new note.
pub fn create_frontmatter(title: &str, tags: &[String]) -> NoteFrontmatter {
    let now = current_iso();
    NoteFrontmatter {
        id: generate_note_id(),
        title: Some(title.to_string()),
        created: now.clone(),
        modified: now,
        tags: tags.to_vec(),
        aliases: Vec::new(),
        emoji: None,
        local_only: None,
        properties: None,
        extra: BTreeMap::new(),
    }
}

fn split_frontmatter(raw: &str) -> (String, String, bool) {
    let trimmed = raw.trim_start_matches('\u{FEFF}');
    if !trimmed.starts_with("---") {
        return (String::new(), trimmed.to_string(), false);
    }
    let after_open = &trimmed[3..];
    let after_open = after_open.trim_start_matches('\r').trim_start_matches('\n');
    if let Some(end_idx) = find_closing_fence(after_open) {
        let yaml_text = after_open[..end_idx].to_string();
        let mut rest = &after_open[end_idx..];
        rest = rest.trim_start_matches("---");
        rest = rest.trim_start_matches('\r').trim_start_matches('\n');
        (yaml_text, rest.to_string(), true)
    } else {
        (String::new(), trimmed.to_string(), false)
    }
}

fn find_closing_fence(text: &str) -> Option<usize> {
    let mut start = 0usize;
    while let Some(idx) = text[start..].find("\n---") {
        let candidate = start + idx + 1;
        let after = &text[candidate + 3..];
        if after.is_empty() || after.starts_with('\r') || after.starts_with('\n') {
            return Some(candidate);
        }
        start = candidate + 1;
    }
    None
}

fn extract_title_from_path(path: &str) -> String {
    let leaf = Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(path);
    leaf.replace(['-', '_'], " ")
        .split_whitespace()
        .map(capitalize)
        .collect::<Vec<_>>()
        .join(" ")
}

fn capitalize(word: &str) -> String {
    let mut chars = word.chars();
    match chars.next() {
        None => String::new(),
        Some(first) => {
            let mut s = first.to_uppercase().collect::<String>();
            s.push_str(chars.as_str());
            s
        }
    }
}

fn current_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    unix_secs_to_iso(secs)
}

pub(crate) fn unix_secs_to_iso(secs: u64) -> String {
    let days_per_month = |y: u64, m: u64| -> u64 {
        let leap = is_leap_year(y);
        match m {
            1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
            4 | 6 | 9 | 11 => 30,
            2 => {
                if leap {
                    29
                } else {
                    28
                }
            }
            _ => 0,
        }
    };
    let mut s = secs;
    let secs_part = s % 60;
    s /= 60;
    let mins_part = s % 60;
    s /= 60;
    let hours_part = s % 24;
    s /= 24;
    let mut year: u64 = 1970;
    loop {
        let leap = is_leap_year(year);
        let yd = if leap { 366 } else { 365 };
        if s < yd {
            break;
        }
        s -= yd;
        year += 1;
    }
    let mut month: u64 = 1;
    while month <= 12 {
        let md = days_per_month(year, month);
        if s < md {
            break;
        }
        s -= md;
        month += 1;
    }
    let day = s + 1;
    format!("{year:04}-{month:02}-{day:02}T{hours_part:02}:{mins_part:02}:{secs_part:02}Z")
}

fn is_leap_year(year: u64) -> bool {
    (year.is_multiple_of(4) && !year.is_multiple_of(100)) || year.is_multiple_of(400)
}

fn generate_note_id() -> String {
    nanoid::nanoid!(21)
}

fn yaml_value_to_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        other => yaml::to_string(other)
            .unwrap_or_default()
            .trim()
            .to_string(),
    }
}
