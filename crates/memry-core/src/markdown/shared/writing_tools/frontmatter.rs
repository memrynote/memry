//! The `writing` frontmatter value. It comes from the note's YAML, so it is
//! read from a `serde_json::Value` and written back as one.

use serde_json::{Map, Value};

use super::markers::is_writing_alternative_id;
use super::types::{
    WRITING_FRONTMATTER_KEY, WritingFrontmatter, WritingFrontmatterAlternative,
    WritingFrontmatterOverflowItem, WritingFrontmatterVersion,
};

fn text_of(value: &Value) -> Option<&str> {
    value.as_str().filter(|text| !text.is_empty())
}

fn read_version(value: &Value) -> Option<WritingFrontmatterVersion> {
    if let Some(text) = value.as_str() {
        return (!text.is_empty()).then(|| WritingFrontmatterVersion {
            text: text.to_owned(),
            ai: None,
        });
    }
    let text = text_of(value.as_object()?.get("text")?)?;
    Some(WritingFrontmatterVersion {
        text: text.to_owned(),
        ai: (value.get("ai") == Some(&Value::Bool(true))).then_some(true),
    })
}

fn read_alternative(value: &Value) -> Option<WritingFrontmatterAlternative> {
    let (versions, original) = match value {
        Value::Array(versions) => (versions, None),
        Value::Object(raw) => (
            raw.get("versions")?.as_array()?,
            raw.get("original").and_then(Value::as_str),
        ),
        _ => return None,
    };
    let versions: Vec<_> = versions.iter().filter_map(read_version).collect();
    (!versions.is_empty()).then(|| WritingFrontmatterAlternative {
        original: original.map(str::to_owned),
        versions,
    })
}

fn read_overflow_item(value: &Value) -> Option<WritingFrontmatterOverflowItem> {
    if let Some(text) = value.as_str() {
        return (!text.is_empty()).then(|| WritingFrontmatterOverflowItem {
            text: text.to_owned(),
            label: None,
        });
    }
    let text = text_of(value.as_object()?.get("text")?)?;
    Some(WritingFrontmatterOverflowItem {
        text: text.to_owned(),
        label: value.get("label").and_then(text_of).map(str::to_owned),
    })
}

/// Whether `key` is a JavaScript array index (`"0"`, `"17"`, up to 2^32 - 2).
fn array_index(key: &str) -> Option<u32> {
    if key.is_empty() || (key.len() > 1 && key.starts_with('0')) {
        return None;
    }
    if !key.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    key.parse::<u32>().ok().filter(|n| *n != u32::MAX)
}

/// `Object.entries` order: array-index keys ascending, then insertion order.
pub(crate) fn js_entry_order<T>(entries: &mut [(String, T)]) {
    entries.sort_by_key(|(key, _)| match array_index(key) {
        Some(index) => (0, u64::from(index)),
        None => (1, 0),
    });
}

/// The `writing` frontmatter value, or `None` when the value is not one: a
/// `writing:` key the author uses for something else stays their property.
pub fn read_writing_frontmatter(value: &Value) -> Option<WritingFrontmatter> {
    let object = value.as_object()?;
    if object.is_empty()
        || object
            .keys()
            .any(|key| key != "alternatives" && key != "overflow")
    {
        return None;
    }
    let alternatives_raw = match object.get("alternatives") {
        None => None,
        Some(Value::Object(map)) => Some(map),
        Some(_) => return None,
    };
    let overflow_raw = match object.get("overflow") {
        None => None,
        Some(Value::Array(items)) => Some(items),
        Some(_) => return None,
    };

    let mut alternatives: Vec<_> = alternatives_raw
        .into_iter()
        .flatten()
        .filter(|(id, _)| is_writing_alternative_id(id))
        .filter_map(|(id, entry)| Some((id.clone(), read_alternative(entry)?)))
        .collect();
    js_entry_order(&mut alternatives);
    let overflow = overflow_raw
        .into_iter()
        .flatten()
        .filter_map(read_overflow_item)
        .collect();
    Some(WritingFrontmatter {
        alternatives,
        overflow,
    })
}

/// The writing tools frontmatter of a note whose whole file was read: an
/// absent or foreign `writing` key reads as empty, since the file says there
/// is nothing.
pub fn writing_frontmatter_of(frontmatter: Option<&Value>) -> WritingFrontmatter {
    frontmatter
        .and_then(|front| front.get(WRITING_FRONTMATTER_KEY))
        .and_then(read_writing_frontmatter)
        .unwrap_or_default()
}

pub fn is_writing_frontmatter_value(value: &Value) -> bool {
    read_writing_frontmatter(value).is_some()
}

/// The YAML-shaped value for `writing`, or `None` when there is nothing to
/// keep (the key is then removed). User versions and unlabelled overflow items
/// are bare strings so the common case reads as a plain list.
pub fn to_writing_frontmatter_value(writing: &WritingFrontmatter) -> Option<Value> {
    let mut value = Map::new();
    if !writing.alternatives.is_empty() {
        let mut entries: Vec<(String, Value)> = writing
            .alternatives
            .iter()
            .map(|(id, alternative)| {
                let versions: Vec<Value> = alternative
                    .versions
                    .iter()
                    .map(|version| {
                        if version.ai == Some(true) {
                            let mut object = Map::new();
                            object.insert("text".into(), Value::String(version.text.clone()));
                            object.insert("ai".into(), Value::Bool(true));
                            Value::Object(object)
                        } else {
                            Value::String(version.text.clone())
                        }
                    })
                    .collect();
                let mut object = Map::new();
                if let Some(original) = &alternative.original {
                    object.insert("original".into(), Value::String(original.clone()));
                }
                object.insert("versions".into(), Value::Array(versions));
                (id.clone(), Value::Object(object))
            })
            .collect();
        js_entry_order(&mut entries);
        // `Object.fromEntries`: a repeated id keeps its place and takes the last value.
        let mut alternatives = Map::new();
        for (id, entry) in entries {
            alternatives.insert(id, entry);
        }
        value.insert("alternatives".into(), Value::Object(alternatives));
    }
    if !writing.overflow.is_empty() {
        let items = writing.overflow.iter().map(|item| match &item.label {
            Some(label) if !label.is_empty() => {
                let mut object = Map::new();
                object.insert("label".into(), Value::String(label.clone()));
                object.insert("text".into(), Value::String(item.text.clone()));
                Value::Object(object)
            }
            _ => Value::String(item.text.clone()),
        });
        value.insert("overflow".into(), Value::Array(items.collect()));
    }
    (!value.is_empty()).then_some(Value::Object(value))
}
